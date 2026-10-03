-- Chat Assistant LB-7: record what actually happened to a lead alert.
-- 'sent' used to be written before the email was attempted, so test leads with
-- CHAT_LEAD_ALERT_MODE off, or a failed Resend call, still counted toward the
-- one-per-phone / per-IP caps and suppressed the next real alert.
--   failed      -> mode=email but the send failed (missing key, Resend 4xx/5xx, timeout)
--   not_sent_off -> CHAT_LEAD_ALERT_MODE off/unset (lead stays in the DB)
alter table chat_alerts drop constraint if exists chat_alerts_status_check;
alter table chat_alerts add constraint chat_alerts_status_check check (
  status in ('sent', 'suppressed_duplicate', 'suppressed_ip_cap', 'suppressed_global_cap', 'failed', 'not_sent_off')
);
