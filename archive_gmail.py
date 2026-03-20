#!/usr/bin/env python3
"""Archive a Gmail message by IMAP UID."""
import imaplib
import os
import sys

# Load .env
env_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
if os.path.exists(env_file):
    with open(env_file) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip())

uid = sys.argv[1] if len(sys.argv) > 1 else None
if not uid:
    print('{"ok":false,"error":"No UID provided"}')
    sys.exit(1)

try:
    mail = imaplib.IMAP4_SSL('imap.gmail.com')
    mail.login(os.environ['GMAIL_ADDRESS'], os.environ['GMAIL_APP_PASSWORD'])
    mail.select('INBOX')

    # Gmail IMAP archive = copy to All Mail + remove from Inbox
    typ, _ = mail.uid('COPY', uid, '"[Gmail]/All Mail"')
    if typ == 'OK':
        mail.uid('STORE', uid, '+FLAGS', '(\\Deleted)')
        mail.expunge()
        print('{"ok":true}')
    else:
        print('{"ok":false,"error":"Copy failed"}')

    mail.logout()
except Exception as e:
    print(f'{{"ok":false,"error":"{str(e)}"}}')
