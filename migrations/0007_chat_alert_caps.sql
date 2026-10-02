-- Chat Assistant: lead-alert flood control (Kiara run 1, E2).
-- One row per completed lead that reached the alert step. status says whether
-- the alert was sent or suppressed (and why). Suppressed leads stay in
-- chat_leads / chat_messages with their full transcript; they just don't alert.
create table if not exists chat_alerts (
  id bigserial primary key,
  session_id uuid not null,
  phone text,
  ip_hash text,
  status text not null check (status in ('sent', 'suppressed_duplicate', 'suppressed_ip_cap', 'suppressed_global_cap')),
  created_at timestamptz not null default now()
);
create index if not exists chat_alerts_phone_idx on chat_alerts (phone, created_at desc);
create index if not exists chat_alerts_ip_idx on chat_alerts (ip_hash, created_at desc);
create index if not exists chat_alerts_created_idx on chat_alerts (created_at desc);

alter table chat_leads add column if not exists alert_status text;
