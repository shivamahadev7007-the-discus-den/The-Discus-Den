-- The Discus Den website Chat Assistant (POST /api/chat).
-- Additive only. No raw IPs are stored: ip_hash is sha256(CHAT_IP_SALT + ip).

-- One row per browser chat session (sessionId is a client-generated UUID).
create table if not exists chat_sessions (
  id uuid primary key,
  source text not null default 'site',
  ip_hash text,
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists chat_sessions_updated_idx on chat_sessions (updated_at desc);

-- Every message, user and bot.
create table if not exists chat_messages (
  id bigserial primary key,
  session_id uuid not null,
  role text not null check (role in ('user', 'bot')),
  text text not null,
  source text not null default 'site',
  ip_hash text,
  intent text,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_session_idx on chat_messages (session_id, id);
create index if not exists chat_messages_created_idx on chat_messages (created_at desc);

-- One lead per session, filled in by the handoff flow.
create table if not exists chat_leads (
  session_id uuid primary key,
  source text not null default 'site',
  name text,
  phone text,
  city text,
  state_name text,
  in_ship_states boolean,
  pair_single text,
  delivery text,
  timeline text,
  tags jsonb not null default '[]'::jsonb,
  flags jsonb not null default '[]'::jsonb,
  interest text,
  completed boolean not null default false,
  completed_at timestamptz,
  alert_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists chat_leads_completed_idx on chat_leads (completed, completed_at desc);

-- Fixed-window rate-limit counters (serverless-safe, no in-memory state).
create table if not exists chat_rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (bucket, window_start)
);
create index if not exists chat_rate_limits_window_idx on chat_rate_limits (window_start);
