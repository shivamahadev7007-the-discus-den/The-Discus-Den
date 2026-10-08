# Chat emails (one per chat)

LB-19 (Shiva, 8 Oct 2026): every website chat sends Shiva **exactly one email, when the chat ends**,
with the full transcript of that chat. There is no instant email when a number is typed.

## When does a chat end?

1. **Visitor closes the chat or leaves the page**: the site calls `POST /api/chat/end` with
   `navigator.sendBeacon(..., JSON.stringify({ sessionId }))` (see `/workspace/lb19-surya-brief.md`).
   Accepts `text/plain` or `application/json`, same CORS as `/api/chat`, returns `204`, safe to call twice.
2. **10 minutes with no messages** (`CHAT_IDLE_MINUTES`):
   - every `/api/chat` request ends and emails up to 3 idle chats of other visitors, within a 2.5 s budget,
     in parallel with the reply (anything unfinished is handed to `waitUntil` as best effort only);
   - a visitor's own idle chat is ended when they write again;
   - the daily cron (`/api/chat/cron`, 09:00 IST) ends whatever idle chats are left.
3. **The bot's closing message** after name + number are collected (the send is awaited, as in LB-7).

A new message after a chat has ended starts a **new chat** (new chat id, new email), even from the same
browser session. Exception: "thanks" / "bye" / "ok" within 10 minutes of the closing message stays in the closed chat.

## The email

- Subject `[Lead] New chat lead: <name> — <summary>` when a valid name + mobile (10 digits starting 6–9,
  `+91` / `91` / `0`, spaces and dashes allowed) was captured in that chat; otherwise
  `[Visitor] Website chat: …`, or `[Visitor · likely genuine]` for name + city without a valid mobile.
- Body: tag, name, phone, city, source, earlier-chat details, chat started / last message / ended (+ why),
  chat id, the TDD lead card, and the full transcript of that chat only (HTML escaped + plain text).
- Resend `Idempotency-Key`: `tdd-chat-<chatId>` (per chat, so a returning visitor's email is not deduped).
- Code: `src/lib/chat/lead-alert.ts` (`buildLeadAlertEmail`, `sendLeadAlert`, `buildDigestEmail`, `sendChatDigest`),
  orchestrated by `emailChat` / `handleChatEnd` / `handleChatCron` in `src/lib/chat/http.ts`.

## Never lost: claim, caps, digest

- Table `chat_conversations` (migration `0009_chat_conversations.sql`). `email_status`:
  `pending` → `claimed` → `sent`, or `failed` / `capped` / `off`. The claim flips to `sent` **only after Resend
  says OK**; on failure it is released as `failed`. A claim older than 2 minutes (frozen isolate) can be re-claimed.
- Caps: global `CHAT_ALERT_GLOBAL_CAP_HOUR` (default 20/hour) for all chat emails; per-IP
  `CHAT_ALERT_IP_CAP_24H` (default 3 per 24 h) for **Visitor** emails only. Leads are never IP-capped.
  A capped chat is recorded as `capped`.
- Daily digest (the cron): one email `[Digest] N website chats not emailed yet (k Lead) — <date>` listing
  every ended chat that was never emailed (failed, capped, mode off, ended by the cron), then marks them `sent`
  (`email_via = digest`). If the digest itself fails they stay queued for the next day.
- Every skip is logged as `[chat] lead alert skipped: <reason>`; a send logs
  `[chat] lead alert sent: email via Resend id=<resend id>`. Each attempt also writes a `chat_alerts` audit row.

## Env vars (Vercel, Production)

| Name | Value | Required |
|---|---|---|
| `CHAT_LEAD_ALERT_MODE` | `email` (unset/`off` = log only, `console` = log full alert) | yes |
| `RESEND_API_KEY` | Resend API key, "Sending access" | yes (secret) |
| `CHAT_LEAD_ALERT_EMAIL_TO` | `shivamahadev7007@gmail.com` | yes |
| `CRON_SECRET` | any long random string; Vercel sends it to the cron as `Authorization: Bearer …` | yes (secret, new in LB-19) |
| `CHAT_LEAD_ALERT_FROM` | default `The Discus Den Chat <onboarding@resend.dev>` | no |
| `CHAT_LEAD_ALERT_TIMEOUT_MS` | default `5000` | no |
| `CHAT_IDLE_MINUTES` | default `10` | no |
| `CHAT_ALERT_IP_CAP_24H` | default `3` (Visitor emails only) | no |
| `CHAT_ALERT_GLOBAL_CAP_HOUR` | default `20` | no |

The cron is declared in `vercel.json` (and in the Nitro Vercel config): `30 3 * * *` UTC = 09:00 IST.
Without `CRON_SECRET` the cron route still works but logs a warning and anyone could trigger a digest.

`onboarding@resend.dev` can only send to the email address that owns the Resend account, so sign up to
Resend with the same address as `CHAT_LEAD_ALERT_EMAIL_TO`. To send from your own domain later, verify the
domain in Resend and set `CHAT_LEAD_ALERT_FROM`.

If `CHAT_LEAD_ALERT_MODE=email` but the key or recipient is missing, the server logs
`[chat] lead alert failed: CHAT_LEAD_ALERT_MODE=email but RESEND_API_KEY is not set`, the chat is marked
`failed`, and it goes into the next digest once the env is fixed.
