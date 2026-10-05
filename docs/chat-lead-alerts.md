# Chat lead alerts (email)

As soon as a website chat visitor has given a name and a valid number, The Discus Den
emails Shiva one lead alert (LB-7: it no longer waits for city / pair / delivery / timeline,
because visitors often stop replying after the number; those answers stay in the DB).

## How it works

- Code: `src/lib/chat/lead-alert.ts` (`sendLeadAlert`, `buildLeadAlertEmail`), called from `src/lib/chat/http.ts`.
- Fires on the turn name + valid number are both captured (or the handoff completes). One email per session:
  `chat_leads.alert_sent_at` is claimed once in the DB, flood caps (`chat_alerts`) still apply,
  and Resend gets an `Idempotency-Key` of `tdd-chat-lead-<sessionId>`.
- Provider: Resend, plain `fetch` to `https://api.resend.com/emails` (no SDK). 5 s timeout.
- The send is **awaited** before the HTTP reply returns (`sendLeadAlert` times out at 5 s). An earlier
  `waitUntil` fire-and-forget left phantom `sent` rows when Vercel froze the isolate, which then
  tripped the per-phone / per-IP caps so later real leads got no email (LB-7, 5 Oct 2026).
- A `chat_alerts` row with status `sent` is written **only after** Resend accepts the email.
  Soft-fail: a mail error never blocks the chat reply (alert_status becomes `failed` / `not_sent_off`).
  affect the chat reply. The lead is always stored in the DB either way.
- A successful send logs `[chat] lead alert sent: email via Resend id=<resend id>`.
- `chat_alerts.status` / `chat_leads.alert_status`: `sent` only when the alert really went out;
  `failed` (mode=email but key missing / Resend error / timeout) and `not_sent_off` (mode off) do not
  count toward the one-per-number-per-24 h and per-IP caps (LB-7, migration 0008).
- Email: subject `New chat lead: <name> — <summary>` (tags such as DOA CLAIM / MORTALITY ASKED / LONG HOLD,
  strains, place, fish-or-food); body has name, phone and any email the customer typed, the TDD lead card,
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
