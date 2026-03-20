#!/usr/bin/env python3
"""One-time Telegram user session auth. Run interactively in terminal."""
import asyncio
from telethon import TelegramClient

API_ID = 36193810
API_HASH = '59a033c83b65aaff26bc6491af81afb9'
SESSION_FILE = '/Users/elf-6/mission-control-server/telegram_user'

async def main():
    client = TelegramClient(SESSION_FILE, API_ID, API_HASH)
    await client.start()
    me = await client.get_me()
    print(f"\nAuthenticated as: {me.first_name} (@{me.username})")
    print(f"Session saved to: {SESSION_FILE}.session")
    print("You won't need to do this again.")
    await client.disconnect()

asyncio.run(main())
