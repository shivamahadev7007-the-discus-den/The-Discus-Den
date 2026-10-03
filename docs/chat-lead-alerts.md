# Chat lead alerts (email)

When a website chat visitor completes a handoff ("I've passed this to Shiva…"),
The Discus Den emails Shiva one lead alert.

## How it works

- Code: `src/lib/chat/lead-alert.ts` (`sendLeadAlert`, `buildLeadAlertEmail`), called from `src/lib/chat/http.ts`.
- Fires only on the turn a handoff completes (name + valid number). One email per session:
  `chat_leads.alert_sent_at` is claimed once in the DB, flood caps (`chat_alerts`) still apply,
  and Resend gets an `Idempotency-Key` of `tdd-chat-lead-<sessionId>`.
- Provider: Resend, plain `fetch` to `https://api.resend.com/emails` (no SDK). 5 s timeout.
- On Vercel the send runs via the request context's `waitUntil`, so the customer's reply is not held;
  elsewhere it is awaited (bounded by the timeout). Failures log `[chat] lead alert failed: …` and never
  affect the chat reply. The lead is always stored in the DB either way.
- Email: subject `New chat lead: <name> — <summary>` (tags such as DOA CLAIM / MORTALITY ASKED / LONG HOLD,
  strains, place, pair/single); body has name, phone and any email the customer typed, the TDD lead card,
  and the full transcript (HTML escaped + plain-text part).

## Env vars (Vercel, Production)

| Name | Value | Required |
|---|---|---|
| `CHAT_LEAD_ALERT_MODE` | `email` (unset/`off` = log only, `console` = log full alert) | yes |
| `RESEND_API_KEY` | Resend API key, "Sending access" | yes (secret) |
| `CHAT_LEAD_ALERT_EMAIL_TO` | `shivamahadev7007@gmail.com` | yes |
| `CHAT_LEAD_ALERT_FROM` | default `The Discus Den Chat <onboarding@resend.dev>` | no |
| `CHAT_LEAD_ALERT_TIMEOUT_MS` | default `5000` | no |

`onboarding@resend.dev` can only send to the email address that owns the Resend account, so sign up to
Resend with the same address as `CHAT_LEAD_ALERT_EMAIL_TO`. To send from your own domain later, verify the
domain in Resend and set `CHAT_LEAD_ALERT_FROM`.

If `CHAT_LEAD_ALERT_MODE=email` but the key or recipient is missing, the server logs
`[chat] lead alert failed: CHAT_LEAD_ALERT_MODE=email but RESEND_API_KEY is not set` and the chat keeps working.
