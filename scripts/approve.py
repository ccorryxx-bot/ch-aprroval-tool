"""Approve all pending join requests for the channels configured in the Worker."""
import asyncio
import json
import os
import sys
import urllib.request

from telethon import TelegramClient, errors
from telethon.sessions import StringSession
from telethon.tl import types
from telethon.tl.functions.messages import (
    GetChatInviteImportersRequest,
    HideAllChatJoinRequestsRequest,
)

UA = "ch-approval-runner/1.0"  # custom UA: Cloudflare may block the default python-urllib one


def env(name):
    v = os.environ.get(name, "").strip()
    if not v:
        sys.exit(f"Missing env: {name}")
    return v


WORKER_URL = env("WORKER_URL").rstrip("/")
API_TOKEN = env("WORKER_API_TOKEN")
TRIGGER = "manual" if os.environ.get("TRIGGER") == "manual" else "schedule"


def call_worker(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        WORKER_URL + path,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {API_TOKEN}",
            "Content-Type": "application/json",
            "User-Agent": UA,
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read() or b"{}")


def report(**payload):
    try:
        call_worker("POST", "/api/report", {"trigger": TRIGGER, **payload})
    except Exception as e:  # never crash because the report failed
        print(f"report failed: {e}")


async def with_flood(fn, retries=2):
    for _ in range(retries + 1):
        try:
            return await fn()
        except errors.FloodWaitError as e:
            if e.seconds > 120:
                raise
            print(f"FloodWait {e.seconds}s ...")
            await asyncio.sleep(e.seconds + 1)
    raise RuntimeError("FloodWait retries exceeded")


async def pending_count(client, entity):
    res = await client(
        GetChatInviteImportersRequest(
            peer=entity,
            offset_date=None,
            offset_user=types.InputUserEmpty(),
            limit=1,
            requested=True,  # only pending join requests
        )
    )
    return res.count


async def resolve(client, ref, state):
    key = int(ref) if ref.lstrip("-").isdigit() else ref
    try:
        return await client.get_entity(key)
    except ValueError:
        if state["dialogs_loaded"]:
            raise
    # numeric ids need the entity cache -> load dialogs once
    await client.get_dialogs()
    state["dialogs_loaded"] = True
    return await client.get_entity(key)


async def process(client, ch, state):
    res = {"id": ch["id"], "title": ch.get("title"), "approved": 0, "pending": 0, "error": None}
    try:
        entity = await resolve(client, ch["id"], state)
        res["title"] = getattr(entity, "title", None) or res["title"]
        before = await with_flood(lambda: pending_count(client, entity))
        if before:
            await with_flood(
                lambda: client(HideAllChatJoinRequestsRequest(peer=entity, approved=True))
            )
            await asyncio.sleep(1.5)
            after = await with_flood(lambda: pending_count(client, entity))
            res["approved"] = max(before - after, 0)
            res["pending"] = after
        print(f"{res['title'] or ch['id']}: pending={before} approved={res['approved']}")
    except errors.ChatAdminRequiredError:
        res["error"] = "Not admin / missing Invite Users right"
    except Exception as e:
        res["error"] = f"{type(e).__name__}: {e}"
    if res["error"]:
        print(f"{ch['id']}: ERROR {res['error']}")
    return res


async def main():
    cfg = call_worker("GET", "/api/channels")
    channels = cfg.get("channels", [])

    if not cfg.get("enabled", True) and TRIGGER != "manual":
        print("Disabled via /off - skipping")
        return
    if not channels:
        print("No channels configured")
        if TRIGGER == "manual":
            report(results=[])
        return

    client = TelegramClient(
        StringSession(env("TG_SESSION")), int(env("TG_API_ID")), env("TG_API_HASH")
    )
    try:
        await client.connect()
        if not await client.is_user_authorized():
            raise RuntimeError("Session is not authorized - regenerate TG_SESSION")
        state = {"dialogs_loaded": False}
        results = [await process(client, ch, state) for ch in channels]
        report(results=results)
    except Exception as e:
        msg = f"{type(e).__name__}: {e}"
        print(f"FATAL {msg}")
        report(fatal=msg)
        sys.exit(1)
    finally:
        await client.disconnect()


asyncio.run(main())
