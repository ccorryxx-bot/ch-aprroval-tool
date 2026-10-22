// ch-aprroval-tool — Cloudflare Worker (Telegram bot control panel)
// KV keys: channels, settings, last_run, stats, fatal_notified_at, err_notified_at

const HOUR = 3600 * 1000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function safeEq(a, b) {
  a = String(a ?? "");
  b = String(b ?? "");
  if (!a || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---------- KV helpers ----------
const kvGet = async (env, key, fallback) => (await env.CH_KV.get(key, "json")) ?? fallback;
const kvPut = (env, key, val) => env.CH_KV.put(key, JSON.stringify(val));
const getChannels = (env) => kvGet(env, "channels", []);
const getSettings = async (env) => ({ enabled: true, ...(await kvGet(env, "settings", {})) });

// ---------- Telegram helpers ----------
async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return r.json().catch(() => ({}));
}

const send = (env, chat_id, text) =>
  tg(env, "sendMessage", {
    chat_id,
    text: text.slice(0, 4000),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });

const adminIds = (env) =>
  String(env.ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);

const notifyAdmins = (env, text) => Promise.all(adminIds(env).map((id) => send(env, id, text)));

// ---------- Channel id parsing ----------
// Accepts: username (with/without @), -100id / bare numeric id, t.me/<username>[/post], t.me/c/<id>[/post]
const RESERVED_PATHS = new Set([
  "joinchat", "addlist", "addstickers", "addemoji", "share", "proxy", "socks",
  "setlanguage", "boost", "giftcode", "invoice", "login", "contact",
]);
const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

function normalizeChannel(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;

  // private channel message link: t.me/c/<id>/<msg>
  let m = s.match(/^(?:https?:\/\/)?(?:t|telegram)\.me\/c\/(\d{6,})(?:[/?#].*)?$/i);
  if (m) return "-100" + m[1];

  // public link: t.me/<username>[/<msg>]
  m = s.match(/^(?:https?:\/\/)?(?:t|telegram)\.me\/([A-Za-z0-9_]+)(?:[/?#].*)?$/i);
  if (m) {
    return USERNAME_RE.test(m[1]) && !RESERVED_PATHS.has(m[1].toLowerCase()) ? "@" + m[1] : null;
  }

  if (/^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(s)) return s;
  if (/^-100\d{5,}$/.test(s)) return s;
  if (/^\d{6,}$/.test(s)) return "-100" + s;
  if (USERNAME_RE.test(s)) return "@" + s; // bare name
  return null;
}

const isInviteLink = (raw) => /(?:t|telegram)\.me\/(?:\+|joinchat\/)/i.test(String(raw || ""));

// Numbered list rendered as a monospace block (Telegram has no real tables)
function channelTable(list) {
  const w = String(list.length).length;
  const rows = list.map((c, i) => {
    const no = String(i + 1).padStart(w, " ");
    const head = `${no}. ${esc(c.title || c.id)}`;
    return c.title ? `${head}\n${" ".repeat(w + 2)}${esc(c.id)}` : head;
  });
  return `<pre>${rows.join("\n")}</pre>`;
}

// ---------- GitHub Actions dispatch ----------
async function dispatchRun(env, trigger = "manual") {
  const r = await fetch(
    `https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GH_PAT}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "ch-approval-worker",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ref: env.GH_REF || "main", inputs: { trigger } }),
    }
  );
  return { ok: r.status === 204, status: r.status, body: r.status === 204 ? "" : await r.text() };
}

// ---------- Bot commands ----------
const COMMANDS = [
  { command: "add", description: "Add channel (name, id or link)" },
  { command: "remove", description: "Show channels, remove by number" },
  { command: "list", description: "Show channels" },
  { command: "run", description: "Approve all pending requests now" },
  { command: "on", description: "Enable scheduled auto-approve" },
  { command: "off", description: "Pause scheduled auto-approve" },
  { command: "status", description: "Last run & stats" },
  { command: "help", description: "Help" },
];

const HELP = [
  "<b>🤖 Channel Approval Tool</b>",
  "",
  "/add &lt;name | id | link&gt; — add channel",
  "/remove — show list · /remove &lt;no.&gt; — remove",
  "/list — show channels",
  "/run — approve all pending now",
  "/on · /off — resume / pause scheduled runs",
  "/status — last run &amp; stats",
  "",
  "ℹ️ The Telethon account must be <b>admin</b> of the channel with <b>Invite Users</b> right.",
].join("\n");

async function statusText(env) {
  const [channels, settings, last, stats] = await Promise.all([
    getChannels(env),
    getSettings(env),
    kvGet(env, "last_run", null),
    kvGet(env, "stats", { total_approved: 0 }),
  ]);
  const lines = [
    `Scheduled runs: <b>${settings.enabled ? "ON ✅" : "OFF ⏸"}</b>`,
    `Channels: <b>${channels.length}</b>`,
    `Total approved: <b>${stats.total_approved || 0}</b>`,
  ];
  if (!last) lines.push("Last run: —");
  else if (last.fatal)
    lines.push(`Last run: ${esc(last.ts)} (${esc(last.trigger)}) ❌ <code>${esc(last.fatal)}</code>`);
  else
    lines.push(
      `Last run: ${esc(last.ts)} (${esc(last.trigger)}) — approved ${last.total}, errors ${last.errors}`
    );
  return lines.join("\n");
}

const ADD_USAGE =
  "Usage: <code>/add &lt;name | id | link&gt;</code>\n" +
  "<code>/add mychannel</code> · <code>/add -1001234567890</code> · <code>/add t.me/mychannel</code>";

async function handleCommand(env, msg) {
  const chat = msg.chat.id;
  const [cmdRaw, ...rest] = (msg.text || "").trim().split(/\s+/);
  const cmd = cmdRaw.split("@")[0].toLowerCase();

  switch (cmd) {
    case "/start":
    case "/help":
      return send(env, chat, HELP);

    case "/add": {
      const raw = rest[0];
      const id = normalizeChannel(raw);
      if (!id)
        return send(
          env,
          chat,
          isInviteLink(raw)
            ? "Invite links can't be resolved. Use a username, channel id or <code>t.me/c/…</code> link.\n\n" + ADD_USAGE
            : ADD_USAGE
        );
      const list = await getChannels(env);
      if (list.some((c) => c.id.toLowerCase() === id.toLowerCase()))
        return send(env, chat, `Already added: <code>${esc(id)}</code>`);
      list.push({ id, title: null, added: new Date().toISOString() });
      await kvPut(env, "channels", list);
      return send(
        env,
        chat,
        `✅ Added <code>${esc(id)}</code> (${list.length} total)\nSession account must be admin with Invite Users right.`
      );
    }

    case "/remove": {
      const list = await getChannels(env);
      if (!list.length) return send(env, chat, "No channels yet. Use /add");

      const arg = rest[0];
      if (!arg)
        return send(
          env,
          chat,
          `<b>Channels (${list.length})</b>\n${channelTable(list)}\nRemove: <code>/remove &lt;no.&gt;</code>`
        );

      let idx = -1;
      if (/^\d{1,3}$/.test(arg)) idx = Number(arg) - 1;
      else {
        const id = normalizeChannel(arg);
        if (id) idx = list.findIndex((c) => c.id.toLowerCase() === id.toLowerCase());
      }
      if (idx < 0 || idx >= list.length)
        return send(
          env,
          chat,
          `❌ No match for <code>${esc(arg)}</code>\n<b>Channels (${list.length})</b>\n${channelTable(list)}`
        );

      const [gone] = list.splice(idx, 1);
      await kvPut(env, "channels", list);
      const tail = list.length
        ? `\n<b>Remaining (${list.length})</b>\n${channelTable(list)}`
        : "\nNo channels left.";
      return send(env, chat, `🗑 Removed ${esc(gone.title || gone.id)}${tail}`);
    }

    case "/list": {
      const list = await getChannels(env);
      if (!list.length) return send(env, chat, "No channels yet. Use /add");
      return send(env, chat, `<b>Channels (${list.length})</b>\n${channelTable(list)}`);
    }

    case "/on":
    case "/off": {
      const settings = await getSettings(env);
      settings.enabled = cmd === "/on";
      await kvPut(env, "settings", settings);
      return send(
        env,
        chat,
        settings.enabled ? "✅ Scheduled auto-approve ON" : "⏸ Scheduled auto-approve OFF (/run still works)"
      );
    }

    case "/run": {
      const res = await dispatchRun(env, "manual");
      if (res.ok) return send(env, chat, "🚀 Runner started — result will arrive here in ~1 min.");
      return send(
        env,
        chat,
        `❌ Dispatch failed (${res.status})\n<code>${esc(res.body.slice(0, 300))}</code>`
      );
    }

    case "/status":
      return send(env, chat, await statusText(env));

    default:
      return send(env, chat, "Unknown command. /help");
  }
}

// ---------- Runner report (GitHub Actions -> Worker) ----------
async function handleReport(env, body) {
  const trigger = body.trigger === "manual" ? "manual" : "schedule";
  const manual = trigger === "manual";
  const now = Date.now();
  const ts = new Date(now).toISOString();

  if (body.fatal) {
    const fatal = String(body.fatal).slice(0, 300);
    await kvPut(env, "last_run", { ts, trigger, fatal });
    const last = Number(await env.CH_KV.get("fatal_notified_at")) || 0;
    if (manual || now - last > HOUR) {
      await env.CH_KV.put("fatal_notified_at", String(now));
      await notifyAdmins(env, `🚨 <b>Runner failed</b>\n<code>${esc(fatal)}</code>`);
    }
    return;
  }

  const results = Array.isArray(body.results) ? body.results : [];
  const total = results.reduce((n, r) => n + (Number(r.approved) || 0), 0);
  const failed = results.filter((r) => r.error);

  // keep channel titles fresh
  const channels = await getChannels(env);
  let dirty = false;
  for (const r of results) {
    const c = channels.find((x) => x.id.toLowerCase() === String(r.id).toLowerCase());
    if (c && r.title && c.title !== r.title) {
      c.title = r.title;
      dirty = true;
    }
  }
  if (dirty) await kvPut(env, "channels", channels);

  const stats = await kvGet(env, "stats", { total_approved: 0 });
  stats.total_approved = (stats.total_approved || 0) + total;
  await kvPut(env, "stats", stats);
  await kvPut(env, "last_run", { ts, trigger, total, errors: failed.length });

  // notify rules: manual = always, scheduled = only when something approved,
  // errors on scheduled runs are throttled to once / 3h
  let notify = manual || total > 0;
  if (!notify && failed.length) {
    const last = Number(await env.CH_KV.get("err_notified_at")) || 0;
    if (now - last > 3 * HOUR) {
      await env.CH_KV.put("err_notified_at", String(now));
      notify = true;
    }
  }
  if (!notify) return;

  const name = (r) => esc(r.title || r.id);
  const lines = [];
  if (!results.length) {
    lines.push("No channels configured — use /add");
  } else if (total > 0) {
    lines.push(`✅ Approved <b>${total}</b> join request(s)`);
    for (const r of results) if (r.approved > 0) lines.push(`• ${name(r)} — ${r.approved}`);
  } else if (!failed.length) {
    lines.push("😴 No pending join requests");
  }
  for (const r of results) if (r.pending > 0) lines.push(`⏳ ${name(r)} — ${r.pending} still pending`);
  for (const r of failed) lines.push(`⚠️ ${name(r)}: <code>${esc(r.error)}</code>`);
  await notifyAdmins(env, lines.join("\n"));
}

// ---------- Router ----------
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (path === "/") return new Response("ch-aprroval-tool ok");

      // Telegram webhook
      if (path === "/webhook" && req.method === "POST") {
        if (!safeEq(req.headers.get("x-telegram-bot-api-secret-token"), env.WEBHOOK_SECRET))
          return new Response("forbidden", { status: 403 });
        const update = await req.json();
        const msg = update.message;
        if (
          msg?.text?.startsWith("/") &&
          msg.chat?.type === "private" &&
          adminIds(env).includes(msg.from?.id)
        ) {
          ctx.waitUntil(handleCommand(env, msg).catch((e) => console.error("cmd error", e)));
        }
        return new Response("ok");
      }

      // One-time setup: open  https://<worker>/setup?token=<API_TOKEN>
      if (path === "/setup") {
        if (!safeEq(url.searchParams.get("token"), env.API_TOKEN))
          return new Response("forbidden", { status: 403 });
        const hook = await tg(env, "setWebhook", {
          url: `${url.origin}/webhook`,
          secret_token: env.WEBHOOK_SECRET,
          allowed_updates: ["message"],
          drop_pending_updates: true,
        });
        const cmds = await tg(env, "setMyCommands", { commands: COMMANDS });
        return json({ webhook: hook, commands: cmds });
      }

      // Runner API (GitHub Actions)
      if (path.startsWith("/api/")) {
        const auth = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
        if (!safeEq(auth, env.API_TOKEN)) return json({ error: "unauthorized" }, 401);

        if (path === "/api/channels" && req.method === "GET") {
          const [channels, settings] = await Promise.all([getChannels(env), getSettings(env)]);
          return json({ enabled: settings.enabled, channels });
        }
        if (path === "/api/report" && req.method === "POST") {
          await handleReport(env, await req.json());
          return json({ ok: true });
        }
      }

      return new Response("Not found", { status: 404 });
    } catch (e) {
      console.error(e);
      return new Response("error", { status: 500 });
    }
  },
};
