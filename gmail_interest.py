#!/usr/bin/env python3
"""Fetch Gmail Interest-labeled messages since last run, with AI sender summaries and link extraction."""
import json, os, sys, urllib.request, time, re, base64
from datetime import datetime, timezone
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from email.utils import parsedate_to_datetime
from collections import OrderedDict
from html.parser import HTMLParser

OLLAMA_URL = "http://localhost:11434/api/generate"
OLLAMA_MODEL = "qwen2.5:7b"
CHANGELOG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gmail_interest_changelog.json")

def read_changelog():
    """Read the changelog to find last run time."""
    if not os.path.exists(CHANGELOG_PATH):
        return []
    try:
        with open(CHANGELOG_PATH) as f:
            return json.load(f)
    except Exception:
        return []

def write_changelog(runs, total_fetched):
    """Append current run to changelog."""
    now = datetime.now(timezone.utc)
    entry = {
        "ran_at": now.isoformat(),
        "epoch": int(now.timestamp()),
        "emails_fetched": total_fetched
    }
    runs.append(entry)
    # Keep last 50 runs
    runs = runs[-50:]
    with open(CHANGELOG_PATH, 'w') as f:
        json.dump(runs, f, indent=2)

def get_query_since(runs):
    """Build Gmail query using last run time, or fallback to 1d."""
    if runs:
        last_epoch = runs[-1].get("epoch", 0)
        if last_epoch > 0:
            return f"label:Interest after:{last_epoch}"
    return "label:Interest newer_than:1d"

token_path = os.path.expanduser("~/.openclaw/skills/gmail-api/token.json")
if not os.path.exists(token_path):
    print(json.dumps({"error": "Gmail token not found", "messages": [], "total": 0, "senders": []}))
    sys.exit(0)

# --- Link extraction ---
# Domains to skip (tracking pixels, unsubscribe, email infrastructure)
SKIP_DOMAINS = {
    'list-manage.com', 'mailchimp.com', 'sendgrid.net', 'constantcontact.com',
    'googleadservices.com', 'google.com/maps', 'schemas.microsoft.com',
    'w3.org', 'fonts.googleapis.com', 'fonts.bunny.net', 'fonts.gstatic.com',
    'unsubscribe', 'manage-preferences', 'optout', 'email-preferences',
    'email.mg.', 'go.pardot.com', 'bcove.video', 'doubleclick.net',
    'facebook.com/tr', 'pixel', 'facebook.com/o.php',
    # Email tracking / redirect services
    'acemlnb.com', 'activehosted.com', 'tracking.', 'click.',
    'cmail20.com', 'cmail19.com', 'link.mail.beehiiv.com',
    'cl.exct.net', 'sli.', 'api.secondstreetapp.com',
    'links2.cointracker.io', 'informeddelivery.usps.com/tracking',
    'go.kiyosakiresearch.com',
    # Generic redirect patterns
    '/proc.php', '/lt.php', '/e3t/', '/click?', '/m_c_t/',
    # More tracking services
    'beehiivstatus.com', 'trk.wsj.com', 'forwardtomyfriend.com',
    'view.exacttarget.com', 'gannettcontests.com',
    'facebook.com/messenger/email', 'facebook.com/email/',
    'hp.beehiiv.com',
}

VALUABLE_DOMAINS = [
    'youtube.com', 'youtu.be', 'skool.com', 'github.com', 'twitter.com',
    'x.com', 'linkedin.com', 'medium.com', 'substack.com', 'notion.so',
    'docs.google.com', 'drive.google.com', 'calendly.com', 'loom.com',
    'zoom.us', 'vimeo.com', 'reddit.com', 'producthunt.com', 'arxiv.org',
    'huggingface.co', 'anthropic.com', 'openai.com',
]

def is_junk_url(url):
    """Filter out tracking, unsubscribe, and infrastructure URLs."""
    lower = url.lower()
    for skip in SKIP_DOMAINS:
        if skip in lower:
            return True
    if re.search(r'\.(png|jpg|gif|svg|ico|css|woff|woff2|ttf)(\?|$)', lower):
        return True
    if 'unsubscribe' in lower or 'optout' in lower or 'manage-preferences' in lower:
        return True
    return False

def classify_url(url):
    """Classify a URL by type."""
    lower = url.lower()
    if 'youtube.com/watch' in lower or 'youtu.be/' in lower:
        return 'video'
    if 'skool.com' in lower:
        return 'community'
    if 'github.com' in lower:
        return 'code'
    if any(d in lower for d in ['zoom.us', 'calendly.com', 'loom.com']):
        return 'meeting'
    if any(d in lower for d in ['docs.google.com', 'notion.so', 'drive.google.com']):
        return 'document'
    for vd in VALUABLE_DOMAINS:
        if vd in lower:
            return 'resource'
    return 'link'

SKOOL_CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "skool_config.json")
ENV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")

def _load_env_file():
    """Load .env file into os.environ if not already set."""
    if not os.path.exists(ENV_PATH):
        return
    with open(ENV_PATH) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, val = line.split('=', 1)
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if key not in os.environ:
                os.environ[key] = val

_load_env_file()

def get_skool_cookie():
    """Load Skool session cookie from env var or config file."""
    # Prefer env var
    cookie = os.environ.get("SKOOL_COOKIE", "").strip()
    if cookie:
        return cookie
    # Fallback to JSON config
    if not os.path.exists(SKOOL_CONFIG_PATH):
        return None
    try:
        with open(SKOOL_CONFIG_PATH) as f:
            cfg = json.load(f)
            cookie = cfg.get("cookie", "").strip()
            return cookie if cookie else None
    except Exception:
        return None

def follow_for_youtube(url, cookie=None, timeout=10):
    """Follow a Skool/community link with auth and extract YouTube URLs."""
    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        }
        if cookie:
            headers['Cookie'] = cookie
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            page = resp.read().decode('utf-8', errors='replace')
        # Find YouTube URLs
        yt_pattern = re.compile(r'https?://(?:www\.)?(?:youtube\.com/watch\?v=|youtu\.be/)([\w-]+)')
        matches = yt_pattern.findall(page)
        seen = set()
        yt_links = []
        for vid_id in matches:
            if vid_id not in seen:
                seen.add(vid_id)
                yt_links.append({
                    'url': f'https://youtube.com/watch?v={vid_id}',
                    'type': 'video'
                })
        return yt_links
    except Exception:
        return []

def extract_links_from_body(body_html):
    """Extract valuable URLs from email HTML body."""
    if not body_html:
        return []
    # Extract href values from <a> tags
    href_pattern = re.compile(r'href=["\']([^"\']+)["\']', re.IGNORECASE)
    raw_urls = href_pattern.findall(body_html)
    # Also grab plain-text URLs
    text_url_pattern = re.compile(r'https?://[^\s<>"\')\]]+')
    # Strip HTML tags for plain text URL extraction
    plain = re.sub(r'<[^>]+>', ' ', body_html)
    raw_urls += text_url_pattern.findall(plain)
    # Dedupe, filter, classify
    seen = set()
    links = []
    for url in raw_urls:
        url = url.strip().rstrip('.')
        if url in seen or len(url) < 10 or len(url) > 500:
            continue
        seen.add(url)
        if is_junk_url(url):
            continue
        if not url.startswith('http'):
            continue
        link_type = classify_url(url)
        links.append({'url': url, 'type': link_type})
    # Follow Skool links to extract nested YouTube URLs (only if we have auth)
    skool_cookie = get_skool_cookie()
    if skool_cookie:
        community_links = [l for l in links if l['type'] == 'community']
        for cl in community_links[:2]:
            yt_links = follow_for_youtube(cl['url'], cookie=skool_cookie)
            added = 0
            for yt in yt_links:
                if yt['url'] not in seen and added < 3:
                    seen.add(yt['url'])
                    links.append(yt)
                    added += 1
    return links

def get_body_from_payload(payload):
    """Recursively extract HTML or plain text body from Gmail payload."""
    parts = payload.get('parts', [])
    if parts:
        # Multipart — look for text/html first, then text/plain
        html_body = ''
        plain_body = ''
        for part in parts:
            mime = part.get('mimeType', '')
            if mime == 'text/html':
                data = part.get('body', {}).get('data', '')
                if data:
                    html_body = base64.urlsafe_b64decode(data).decode('utf-8', errors='replace')
            elif mime == 'text/plain':
                data = part.get('body', {}).get('data', '')
                if data:
                    plain_body = base64.urlsafe_b64decode(data).decode('utf-8', errors='replace')
            elif mime.startswith('multipart/'):
                # Recurse into nested multipart
                nested = get_body_from_payload(part)
                if nested:
                    html_body = html_body or nested
        return html_body or plain_body
    else:
        # Single-part message
        data = payload.get('body', {}).get('data', '')
        if data:
            return base64.urlsafe_b64decode(data).decode('utf-8', errors='replace')
    return ''

def summarize_all_senders(sorted_senders):
    """Single Ollama call to summarize ALL senders at once."""
    # Build a compact manifest of all senders and their emails
    lines = []
    for i, (sender_name, emails) in enumerate(sorted_senders, 1):
        subjects = [e['subject'] for e in emails]
        previews = [e['preview'][:100] for e in emails[:3]]  # cap to 3 previews per sender
        lines.append(f"[{i}] {sender_name} ({len(emails)} emails)")
        for s in subjects[:5]:
            lines.append(f"  Subject: {s}")
        if previews:
            lines.append(f"  Preview: {previews[0]}")
    manifest = "\n".join(lines)

    prompt = f"""You are triaging emails for a busy CEO. Below are senders and their email subjects/previews from the last 24 hours.

{manifest}

For EACH numbered sender, write exactly one line in this format:
[number] CATEGORY | verdict | 1-sentence summary

CATEGORY must be one of: SALES PITCH, KNOWLEDGE, NEWS, COMMUNITY, TRANSACTIONAL
verdict must be: WORTH READING or SKIP

Example:
[1] KNOWLEDGE | WORTH READING | Deep dive into AI agent architectures with practical code examples.
[2] SALES PITCH | SKIP | Pushing a $997 course on dropshipping with urgency tactics.

Be direct and honest. One line per sender. No extra text."""

    try:
        payload = json.dumps({
            "model": OLLAMA_MODEL,
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": 0.3, "num_predict": 500}
        }).encode()
        req = urllib.request.Request(OLLAMA_URL, data=payload,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            result = json.loads(resp.read())
            raw = result.get("response", "").strip()
    except Exception as e:
        return {i: f"(Summary unavailable: {e})" for i in range(len(sorted_senders))}

    # Parse responses — match [number] lines
    summaries = {}
    for line in raw.split("\n"):
        line = line.strip()
        if not line or not line.startswith("["):
            continue
        try:
            bracket_end = line.index("]")
            num = int(line[1:bracket_end]) - 1  # 0-indexed
            text = line[bracket_end+1:].strip().lstrip(":").strip()
            summaries[num] = text
        except (ValueError, IndexError):
            continue

    # Fill missing
    for i in range(len(sorted_senders)):
        if i not in summaries:
            summaries[i] = ""
    return summaries

try:
    creds = Credentials.from_authorized_user_file(token_path)
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        with open(token_path, 'w') as f:
            f.write(creds.to_json())

    changelog_runs = read_changelog()
    query = get_query_since(changelog_runs)

    svc = build('gmail', 'v1', credentials=creds)
    results = svc.users().messages().list(
        userId='me', q=query, maxResults=50
    ).execute()
    msgs = results.get('messages', [])

    items = []
    for msg_ref in msgs:
        m = svc.users().messages().get(
            userId='me', id=msg_ref['id'], format='full'
        ).execute()
        headers = {h['name']: h['value'] for h in m.get('payload', {}).get('headers', [])}
        sender = headers.get('From', '')
        sender_name = sender.split('<')[0].strip().strip('"') or sender
        snippet = m.get('snippet', '')[:200]
        date_str = headers.get('Date', '')
        try:
            dt = parsedate_to_datetime(date_str)
            timestamp = dt.isoformat()
        except Exception:
            timestamp = date_str

        # Extract links from email body
        body_html = get_body_from_payload(m.get('payload', {}))
        links = extract_links_from_body(body_html)

        items.append({
            'id': msg_ref['id'],
            'from': sender_name,
            'subject': headers.get('Subject', ''),
            'preview': snippet,
            'date': date_str,
            'timestamp': timestamp,
            'unread': 'UNREAD' in m.get('labelIds', []),
            'links': links
        })

    # Group by sender and generate summaries
    grouped = OrderedDict()
    for item in items:
        key = item['from']
        if key not in grouped:
            grouped[key] = []
        grouped[key].append(item)

    # Sort by count (most emails first)
    sorted_senders = sorted(grouped.items(), key=lambda x: -len(x[1]))

    # Single bulk Ollama call for all senders
    summaries = summarize_all_senders(sorted_senders)

    sender_summaries = []
    for i, (sender_name, emails) in enumerate(sorted_senders):
        sender_summaries.append({
            'name': sender_name,
            'count': len(emails),
            'summary': summaries.get(i, ''),
            'emails': emails
        })

    # Log this run to changelog
    write_changelog(changelog_runs, len(items))

    print(json.dumps({
        'messages': items,
        'total': len(items),
        'senders': sender_summaries,
        'query_used': query,
        'last_run': changelog_runs[-2]['ran_at'] if len(changelog_runs) >= 2 else None
    }))

except Exception as e:
    print(json.dumps({"error": str(e), "messages": [], "total": 0, "senders": []}))
