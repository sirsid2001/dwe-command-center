#!/usr/bin/env python3
"""Unified message collector for CEO Communications Center.
Reads Gmail (IMAP) + Telegram (personal + agent logs) + iMessage and outputs JSON.
iMessage requires Full Disk Access — skipped if DB unreadable.
"""

import asyncio
import imaplib
import email
import email.header
import json
import os
import sys
import glob
import sqlite3
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

# Load .env file
ENV_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
if os.path.exists(ENV_FILE):
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip())

GMAIL_ADDRESS = os.environ.get("GMAIL_ADDRESS", "")
GMAIL_APP_PASSWORD = os.environ.get("GMAIL_APP_PASSWORD", "")
IMAP_SERVER = os.environ.get("IMAP_SERVER", "imap.gmail.com")
HOURS_BACK = 12
MAX_GMAIL = 30
MAX_TELEGRAM = 50
MAX_TELEGRAM_PERSONAL = 50
MAX_IMESSAGE = 20

# Telegram User API
TG_API_ID = int(os.environ.get("TG_API_ID", "0"))
TG_API_HASH = os.environ.get("TG_API_HASH", "")
TG_SESSION_FILE = os.environ.get("TG_SESSION_FILE", "")

def decode_header(val):
    if not val:
        return ""
    parts = email.header.decode_header(val)
    result = []
    for data, charset in parts:
        if isinstance(data, bytes):
            result.append(data.decode(charset or "utf-8", errors="replace"))
        else:
            result.append(data)
    return " ".join(result)

def collect_gmail():
    """Collect recent Gmail messages via Gmail API skill."""
    messages = []
    token_path = os.path.expanduser("~/.openclaw/skills/gmail-api/token.json")
    if not os.path.exists(token_path):
        print("Gmail API token not found — falling back skipped", file=sys.stderr)
        return messages

    try:
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request
        from googleapiclient.discovery import build

        SCOPES = ['https://www.googleapis.com/auth/gmail.readonly',
                   'https://www.googleapis.com/auth/gmail.modify']
        creds = Credentials.from_authorized_user_file(token_path, SCOPES)
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            with open(token_path, 'w') as f:
                f.write(creds.to_json())

        svc = build('gmail', 'v1', credentials=creds)

        # Fetch recent emails (last 24 hours, all labels — not just inbox)
        results = svc.users().messages().list(
            userId='me', q='newer_than:1d -category:spam -category:trash', maxResults=MAX_GMAIL
        ).execute()
        msg_list = results.get('messages', [])

        for msg_ref in msg_list:
            m = svc.users().messages().get(
                userId='me', id=msg_ref['id'], format='metadata',
                metadataHeaders=['From', 'Subject', 'Date']
            ).execute()

            headers = m.get('payload', {}).get('headers', [])
            def get_hdr(name):
                for h in headers:
                    if h['name'].lower() == name.lower():
                        return h['value']
                return ''

            sender = get_hdr('From')
            subject = get_hdr('Subject')
            date_str_hdr = get_hdr('Date')
            snippet = m.get('snippet', '')[:150]
            gmail_id = msg_ref['id']
            labels = m.get('labelIds', [])

            # Parse timestamp
            try:
                dt = parsedate_to_datetime(date_str_hdr)
                timestamp = dt.isoformat()
            except Exception:
                timestamp = date_str_hdr

            # Clean sender name
            sender_name = sender.split("<")[0].strip().strip('"')
            if not sender_name:
                sender_name = sender

            # Gmail deep link using message ID
            gmail_url = f"https://mail.google.com/mail/u/0/#inbox/{gmail_id}"

            # Detect Google Voice forwarded messages
            is_gvoice = ('txt.voice.google.com' in sender.lower() or
                         'voice-noreply@google.com' in sender.lower())
            channel = "gvoice" if is_gvoice else "gmail"

            # Clean up Google Voice sender — extract phone number from subject
            if is_gvoice and subject:
                # GV subjects look like "New text message from (850) 888-8743"
                sender_name = subject.replace("New text message from ", "").replace("New voicemail from ", "")

            messages.append({
                "id": f"{'gv' if is_gvoice else 'gmail'}-{gmail_id}",
                "channel": channel,
                "from": sender_name,
                "subject": "" if is_gvoice else subject,
                "preview": snippet,
                "timestamp": timestamp,
                "raw_id": gmail_id,
                "url": gmail_url,
                "unread": 'UNREAD' in labels,
                "starred": 'STARRED' in labels
            })

    except Exception as e:
        print(f"Gmail API error: {e}", file=sys.stderr)

    return messages

def collect_telegram():
    """Collect recent Telegram messages from OpenClaw session logs."""
    messages = []
    cutoff = datetime.now(timezone.utc) - timedelta(hours=HOURS_BACK)
    session_dirs = glob.glob(os.path.expanduser("~/.openclaw/agents/*/sessions/"))

    for sdir in session_dirs:
        agent = sdir.split("/agents/")[1].split("/")[0]
        # Find most recent .jsonl file
        jsonl_files = sorted(glob.glob(os.path.join(sdir, "*.jsonl")), key=os.path.getmtime, reverse=True)
        for jf in jsonl_files[:2]:  # Check 2 most recent session files per agent
            try:
                with open(jf, "r") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            entry = json.loads(line)
                        except json.JSONDecodeError:
                            continue

                        if entry.get("type") != "message":
                            continue
                        msg = entry.get("message", {})
                        if msg.get("role") != "user":
                            continue

                        ts_str = entry.get("timestamp", "")
                        try:
                            ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                            if ts < cutoff:
                                continue
                        except Exception:
                            continue

                        content = msg.get("content", [])
                        text = ""
                        for block in content:
                            if isinstance(block, dict) and block.get("type") == "text":
                                text = block.get("text", "")
                                break
                            elif isinstance(block, str):
                                text = block
                                break

                        if not text or len(text) < 5:
                            continue

                        # Skip automated daemon messages
                        if any(kw in text[:80] for kw in [
                            "NIGHT MODE CHECK-IN",
                            "HEARTBEAT",
                            "TRIAGE RUN",
                            "TASK FOLLOW-UP",
                            "ANOMALY CHECK",
                            "SOUL CALIBRATION",
                            "CLAWHUB CHECK"
                        ]):
                            continue

                        messages.append({
                            "id": f"tg-{agent}-{entry.get('id', '')}",
                            "channel": "telegram",
                            "from": f"→ {agent.upper()}",
                            "subject": "",
                            "preview": text[:200],
                            "timestamp": ts_str,
                            "raw_id": entry.get("id", ""),
                            "url": ""
                        })

            except Exception as e:
                print(f"Telegram session error ({jf}): {e}", file=sys.stderr)

    # Deduplicate and sort by timestamp, most recent first
    messages.sort(key=lambda m: m["timestamp"], reverse=True)
    return messages[:MAX_TELEGRAM]

async def collect_telegram_personal():
    """Collect unread Telegram messages from all personal chats via User API."""
    messages = []
    session_path = TG_SESSION_FILE + '.session'
    if not os.path.exists(session_path):
        print("Telegram user session not found — run telegram_auth.py first", file=sys.stderr)
        return messages

    try:
        from telethon import TelegramClient
        client = TelegramClient(TG_SESSION_FILE, TG_API_ID, TG_API_HASH)
        await client.connect()

        if not await client.is_user_authorized():
            print("Telegram session expired — re-run telegram_auth.py", file=sys.stderr)
            await client.disconnect()
            return messages

        me = await client.get_me()
        my_id = me.id

        # DWE bot usernames to skip (already captured by collect_telegram agent logs)
        dwe_bot_usernames = {
            'dwe_cto_bot', 'dwe_chief_engr_bot', 'dwe_cfo_bot',
            'dwe_coo_bot', 'dwe_cio_bot', 'dwe_main_bot'
        }

        cutoff = datetime.now(timezone.utc) - timedelta(hours=HOURS_BACK)

        async for dialog in client.iter_dialogs():
            # Skip DWE bot chats
            if hasattr(dialog.entity, 'username') and dialog.entity.username:
                if dialog.entity.username.lower() in dwe_bot_usernames:
                    continue

            # Only get dialogs with unread messages or recent activity
            if dialog.unread_count == 0 and dialog.date and dialog.date < cutoff:
                continue

            # Get sender name
            name = dialog.name or "Unknown"

            # Determine chat type for deep link
            entity = dialog.entity
            chat_type = "user"
            if hasattr(entity, 'megagroup') and entity.megagroup:
                chat_type = "group"
            elif hasattr(entity, 'broadcast') and entity.broadcast:
                chat_type = "channel"
            elif hasattr(entity, 'gigagroup'):
                chat_type = "group"

            # Build Telegram deep link
            if hasattr(entity, 'username') and entity.username:
                tg_url = f"https://t.me/{entity.username}"
            else:
                tg_url = ""

            # Fetch recent unread messages from this dialog
            count = 0
            async for msg in client.iter_messages(dialog, limit=min(dialog.unread_count or 3, 10)):
                if msg.date and msg.date < cutoff:
                    break
                # Skip messages from me
                if msg.sender_id == my_id:
                    continue
                text = msg.text or ""
                if not text or len(text) < 2:
                    # Check for media
                    if msg.media:
                        text = "[Media attachment]"
                    else:
                        continue

                # Sender within group chats
                sender_name = name
                if chat_type in ("group", "channel"):
                    if msg.sender:
                        fn = getattr(msg.sender, 'first_name', '') or ''
                        ln = getattr(msg.sender, 'last_name', '') or ''
                        sender_name = f"{name} › {fn} {ln}".strip()

                messages.append({
                    "id": f"tgp-{msg.id}-{dialog.id}",
                    "channel": "telegram",
                    "from": sender_name,
                    "subject": f"{'📢' if chat_type == 'channel' else '👥' if chat_type == 'group' else ''} {'Unread' if dialog.unread_count > 0 else ''}".strip(),
                    "preview": text[:200],
                    "timestamp": msg.date.isoformat() if msg.date else "",
                    "raw_id": str(msg.id),
                    "url": tg_url
                })
                count += 1
                if count >= 5:  # Max 5 messages per dialog
                    break

        await client.disconnect()
    except Exception as e:
        print(f"Telegram personal error: {e}", file=sys.stderr)

    messages.sort(key=lambda m: m["timestamp"], reverse=True)
    return messages[:MAX_TELEGRAM_PERSONAL]

def collect_imessage():
    """Collect recent iMessages from local SQLite DB."""
    messages = []
    db_path = os.path.expanduser("~/Library/Messages/chat.db")
    if not os.access(db_path, os.R_OK):
        return messages  # FDA not granted

    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        c = conn.cursor()
        # iMessage stores dates as Core Data timestamps (seconds since 2001-01-01)
        # Convert cutoff to Core Data timestamp
        epoch_2001 = datetime(2001, 1, 1, tzinfo=timezone.utc)
        cutoff = datetime.now(timezone.utc) - timedelta(hours=HOURS_BACK)
        cutoff_ns = int((cutoff - epoch_2001).total_seconds() * 1e9)

        c.execute("""
            SELECT m.ROWID, m.text, m.date, m.is_from_me,
                   h.id as handle_id,
                   COALESCE(h.uncanonicalized_id, h.id) as sender
            FROM message m
            LEFT JOIN handle h ON m.handle_id = h.ROWID
            WHERE m.date > ? AND m.text IS NOT NULL AND m.text != ''
            ORDER BY m.date DESC
            LIMIT ?
        """, (cutoff_ns, MAX_IMESSAGE))

        for row in c.fetchall():
            rowid, text, date_ns, is_from_me, handle_id, sender = row
            # Convert Core Data nanoseconds to ISO timestamp
            ts = epoch_2001 + timedelta(seconds=date_ns / 1e9)
            direction = "You → " if is_from_me else ""
            # Build iMessage deep link for reply
            imsg_url = ""
            if sender:
                from urllib.parse import quote
                imsg_url = f"imessage://{quote(sender)}"
            messages.append({
                "id": f"imsg-{rowid}",
                "channel": "imessage",
                "from": f"{direction}{sender or 'Unknown'}",
                "subject": "",
                "preview": (text or "")[:200],
                "timestamp": ts.isoformat(),
                "raw_id": str(rowid),
                "url": imsg_url
            })

        conn.close()
    except Exception as e:
        print(f"iMessage error: {e}", file=sys.stderr)

    return messages

async def main():
    all_messages = []
    all_messages.extend(collect_gmail())
    all_messages.extend(collect_telegram())
    all_messages.extend(await collect_telegram_personal())
    all_messages.extend(collect_imessage())

    # Sort all by timestamp descending
    all_messages.sort(key=lambda m: m.get("timestamp", ""), reverse=True)

    result = {
        "ok": True,
        "messages": all_messages,
        "channels": {
            "gmail": len([m for m in all_messages if m["channel"] == "gmail"]),
            "telegram": len([m for m in all_messages if m["channel"] == "telegram"]),
            "imessage": len([m for m in all_messages if m["channel"] == "imessage"]),
            "gvoice": len([m for m in all_messages if m["channel"] == "gvoice"])
        },
        "collected_at": datetime.now(timezone.utc).isoformat()
    }
    print(json.dumps(result))

if __name__ == "__main__":
    asyncio.run(main())
