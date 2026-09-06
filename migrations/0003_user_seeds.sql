create table if not exists user_seeds (
  user_id text not null,
  seed_key text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, seed_key)
);
