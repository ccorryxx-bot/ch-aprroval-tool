# ch-aprroval-tool

Telegram channel **join-request auto-approve**, controlled from a Telegram bot.

```
You ──/add /run──▶ Telegram Bot ──▶ Cloudflare Worker (+KV: channel list)
                                          │  ▲
                       workflow_dispatch  │  │ GET /api/channels, POST /api/report
                                          ▼  │
                          GitHub Actions (cron */5 + manual) ── Telethon ──▶ approve all pending
```

- **Channel IDs** → stored in Cloudflare KV, managed with `/add` `/remove` `/list`.
- **Telethon session + API ID/HASH** → GitHub **Secrets** (never in code).
- **Bot token / admin id / GitHub PAT** → Cloudflare Worker **Secrets**.

## Bot commands
`/add <-100id|@username>` · `/remove <id|no.>` · `/list` · `/run` · `/on` · `/off` · `/status` · `/help`

## Setup

### 1. Cloudflare Worker secrets
| Name | Value |
|---|---|
| `BOT_TOKEN` | token from @BotFather |
| `ADMIN_IDS` | your Telegram user id (comma-separate for many) |
| `GH_PAT` | GitHub token that can run workflows on this repo (classic: `repo`+`workflow`, or fine-grained: *Actions: Read & write*) |
| `API_TOKEN` | random string (`openssl rand -hex 24`) — shared with GitHub |
| `WEBHOOK_SECRET` | random string, letters/digits/`_`/`-` only |

Then open once: `https://<worker>.workers.dev/setup?token=<API_TOKEN>` → sets the webhook + bot menu.

### 2. GitHub repo secrets (Settings → Secrets and variables → Actions)
| Name | Value |
|---|---|
| `TG_API_ID` | from https://my.telegram.org |
| `TG_API_HASH` | from https://my.telegram.org |
| `TG_SESSION` | output of `python scripts/gen_session.py` (run locally) |
| `WORKER_URL` | `https://<worker>.workers.dev` |
| `WORKER_API_TOKEN` | same value as the Worker's `API_TOKEN` |

### 3. Telegram side
- The Telethon account must be **admin** in each channel with the **Invite Users** right.
- Channel must use *Approve new members* (join-request invite link).

## Notes
- Use a **dedicated session** for this repo. Using one session string from two places at the same time can kill it (`AuthKeyDuplicatedError`).
- GitHub pauses scheduled workflows after 60 days with no repo activity — push a commit or re-enable if that happens.
- Scheduled runs only message you when something was approved (errors are throttled); `/run` always replies.
