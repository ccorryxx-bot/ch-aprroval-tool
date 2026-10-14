"""Run this LOCALLY once to get a Telethon StringSession for GitHub Secrets (TG_SESSION).
   pip install telethon && python scripts/gen_session.py
"""
import asyncio

from telethon import TelegramClient
from telethon.sessions import StringSession

api_id = int(input("API ID: ").strip())
api_hash = input("API HASH: ").strip()


async def main():
    # entering the context manager runs the interactive phone / code / 2FA login
    async with TelegramClient(StringSession(), api_id, api_hash) as client:
        print("\n=== TG_SESSION (keep it secret!) ===")
        print(client.session.save())


asyncio.run(main())
