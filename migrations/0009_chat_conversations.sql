-- Chat Assistant LB-19: one row per CHAT (conversation), separate from the browser
-- session. The site widget keeps its sessionId in localStorage forever, so one
-- session can hold many chats; each chat sends exactly ONE email to Shiva, when it
-- ends, with the full transcript (subject tagged Lead if a name + valid Indian mobile
-- were captured, otherwise Visitor). Anything ended but never emailed (failed send,
-- capped, mode off) is listed in the daily cron digest.
-- A chat ends on POST /api/chat/end (widget close / pagehide), after 10 min idle,
-- or with the bot's closing message once details are collected. The next message
-- on that session starts a new chat (new row), so returning visitors email again.
-- Additive only: existing tables/rows are untouched apart from two nullable columns.
create table if not exists chat_conversations (
  id uuid primary key,
  session_id uuid not null,
  source text not null default 'site',
  ip_hash text,
  -- engine state snapshot for this chat (the email is built from it, even days later)
  state jsonb not null default '{}'::jsonb,
  name text,
  phone text,
  city text,
  user_messages integer not null default 0,
  started_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text check (end_reason in ('beacon', 'idle', 'closing')),
  -- pending -> claimed -> sent | failed | capped | off  (only 'sent' after Resend accepted it)
  email_status text not null default 'pending'
    check (email_status in ('pending', 'claimed', 'sent', 'failed', 'capped', 'off')),
  email_kind text check (email_kind in ('lead', 'visitor')),
  email_via text check (email_via in ('instant', 'digest')),
  email_claimed_at timestamptz,
  emailed_at timestamptz,
  email_attempts integer not null default 0,
  email_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists chat_conversations_session_idx on chat_conversations (session_id, started_at desc);
create index if not exists chat_conversations_open_idx on chat_conversations (last_message_at) where ended_at is null;
create index if not exists chat_conversations_unemailed_idx on chat_conversations (ended_at) where email_status <> 'sent';
create index if not exists chat_conversations_sent_idx on chat_conversations (emailed_at) where email_status = 'sent';

-- Which chat each message belongs to (null for messages from before LB-19).
alter table chat_messages add column if not exists chat_id uuid;
create index if not exists chat_messages_chat_idx on chat_messages (chat_id, id);

-- Audit rows for instant emails now name the chat too.
alter table chat_alerts add column if not exists chat_id uuid;
