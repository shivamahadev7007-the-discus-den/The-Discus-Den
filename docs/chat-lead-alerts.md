# Chat emails (one per chat)

LB-19 (Shiva, 8 Oct 2026): every website chat sends Shiva **exactly one email, when the chat ends**,
with the full transcript of that chat. There is no instant email when a number is typed.

## When does a chat end?

1. **Visitor closes the chat or leaves the page**: the site calls `POST /api/chat/end` with
   `navigator.sendBeacon(..., JSON.stringify({ sessionId }))` (see `/workspace/lb19-surya-brief.md`).
   Accepts `text/plain` or `application/json`, same CORS as `/api/chat`, returns `204`, safe to call twice.
2. **10 minutes with no messages** (`CHAT_IDLE_MINUTES`):
   - every `/api/chat` request ends and emails up to 3 idle chats of other visitors, within a 2.5 s budget,
     in parallel with the reply (anything unfinished is handed to `waitUntil` as best effort only). The same
     sweep also picks up chats that ended but never got their email (ended 2+ min ago, e.g. a frozen isolate);
   - a visitor's own idle chat is ended (and emailed) when they write again;
   - the daily cron (`/api/chat/cron`, 09:00 IST) ends whatever idle chats are left **and emails each of them
     in that same run** (LB-19 fix, Kiara #1).
3. **After the bot's closing message** (name + number collected): the closing message marks the chat
   *closed* but does **not** send yet. The chat stays open, so anything the visitor types next ("thanks",
   one more question) lands in the **same chat and the same single email** (LB-19 fix, Kiara #2). The chat
   ends, and the email goes, on `/api/chat/end` or 10 minutes after the last message (end reason
   "closing message after details were collected, then 10 min with no messages").

A new message after a chat has ended starts a **new chat** (new chat id, new email), even from the same
browser session.

**Timing to expect:** with the widget's beacon (Surya's snippet) the email goes the moment the visitor closes
the chat or leaves the page. Without a beacon it goes ~10 minutes after the last message, as soon as anyone
else uses the chat; on a completely quiet site, at the latest with the 09:00 IST cron.

## The email

- Subject `[Lead] New chat lead: <name> — <summary>` when a valid name + mobile (10 digits starting 6–9,
  `+91` / `91` / `0`, spaces and dashes allowed) was captured in that chat; otherwise
  `[Visitor] Website chat: …`, or `[Visitor · likely genuine]` for name + city without a valid mobile.
  LB-24 (privacy): the email shows only details typed in THIS chat. `[Lead · returning] Website chat: <name> — …`
  is decided server-side only, when the valid number typed in this chat matches one typed in an earlier
  chat on the same browser (compared via one-way keys; the old number is never stored or shown). A
  returning browser with no number typed in this chat is a plain `[Visitor]`. The bot itself never shows
  or uses any earlier chat's name / number (shared devices).
- A country code with too few digits ("+91 98765 000") or any other partial number is never saved: the bot
  asks the visitor to check it, and such a chat is never a Lead.
- Body: tag, name, phone, city (this chat only), source, chat started / last message / ended (+ why),
  chat id, the TDD lead card, and the full transcript of that chat only (HTML escaped + plain text).
- Resend `Idempotency-Key`: `tdd-chat-<chatId>` (per chat, so a returning visitor's email is not deduped).
- Code: `src/lib/chat/lead-alert.ts` (`buildLeadAlertEmail`, `sendLeadAlert`, `buildDigestEmail`, `sendChatDigest`),
  orchestrated by `emailChat` / `handleChatEnd` / `handleChatCron` in `src/lib/chat/http.ts`.

## Never lost: claim, caps, digest

- Table `chat_conversations` (migration `0009_chat_conversations.sql`). `email_status`:
  `pending` → `claimed` → `sent`, or `failed` / `capped` / `off`. The claim flips to `sent` **only after Resend
  says OK**; on failure it is released as `failed`. A claim older than 2 minutes (frozen isolate) can be re-claimed.
- Caps apply to **Visitor** emails only (LB-19 fix, Kiara #3): global `CHAT_ALERT_GLOBAL_CAP_HOUR`
  (default 20 Visitor emails/hour) and per-IP `CHAT_ALERT_IP_CAP_24H` (default 3 Visitor emails per IP per
  24 h). **Leads are never capped** and are not counted toward either cap. A capped Visitor chat is recorded
  as `capped` and goes into the digest.
- Daily cron, in this order: (1) ends idle chats, (2) emails each ended chat that is still waiting for its own
  email (up to 40 per run, 4 at a time, within ~20 s), (3) one digest email
  `[Digest] N website chats not emailed yet (k Lead) — <date>` listing every ended chat that still has no email
  (failed send, capped Visitor, mode off, over the run's limit), then marks them `sent` (`email_via = digest`).
  If the digest itself fails they stay queued for the next day.
- Every skip is logged as `[chat] lead alert skipped: <reason>`; a send logs
  `[chat] lead alert sent: email via Resend id=<resend id>`. Each attempt also writes a `chat_alerts` audit row.

## Env vars (Vercel, Production)

| Name | Value | Required |
|---|---|---|
| `CHAT_LEAD_ALERT_MODE` | `email` (unset/`off` = log only, `console` = log full alert) | yes |
| `RESEND_API_KEY` | Resend API key, "Sending access" | yes (secret) |
| `CHAT_LEAD_ALERT_EMAIL_TO` | `shivamahadev7007@gmail.com` | yes |
| `CRON_SECRET` | any long random string (e.g. `openssl rand -hex 32`); Vercel sends it to the cron as `Authorization: Bearer …` | **yes** (secret, new in LB-19; without it the cron is rejected) |
| `CHAT_LEAD_ALERT_FROM` | default `The Discus Den Chat <onboarding@resend.dev>` | no |
| `CHAT_LEAD_ALERT_TIMEOUT_MS` | default `5000` | no |
| `CHAT_IDLE_MINUTES` | default `10` | no |
| `CHAT_ALERT_IP_CAP_24H` | default `3` (Visitor emails only; Leads never capped) | no |
| `CHAT_ALERT_GLOBAL_CAP_HOUR` | default `20` (Visitor emails only; Leads never capped) | no |

The cron is declared in `vercel.json` (and in the Nitro Vercel config): `30 3 * * *` UTC = 09:00 IST.
The cron route **fails closed**: every request without `Authorization: Bearer <CRON_SECRET>` gets `401`, and
if `CRON_SECRET` is not set at all every request gets `401` and the log says
`[chat] cron: REJECTED (401) because CRON_SECRET is not set. Set CRON_SECRET in Vercel (Production) …`.
So set `CRON_SECRET` in Vercel before (or with) the deploy, or idle chats on a quiet site wait for traffic.

Migrations: `0009_chat_conversations.sql` and `0010_chat_conversations_closing.sql` (adds `closed_at` and an
insertion-order `seq`; additive, safe to run after 0009 has already run).

`onboarding@resend.dev` can only send to the email address that owns the Resend account, so sign up to
Resend with the same address as `CHAT_LEAD_ALERT_EMAIL_TO`. To send from your own domain later, verify the
domain in Resend and set `CHAT_LEAD_ALERT_FROM`.

If `CHAT_LEAD_ALERT_MODE=email` but the key or recipient is missing, the server logs
`[chat] lead alert failed: CHAT_LEAD_ALERT_MODE=email but RESEND_API_KEY is not set`, the chat is marked
`failed`, and it goes into the next digest once the env is fixed.
