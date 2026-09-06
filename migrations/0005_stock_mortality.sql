-- Tank-level died count per item. On hand = bought − this − sold.
create table if not exists stock_mortality (
  id serial primary key,
  user_id text not null,
  item_type text not null check (item_type in ('live_fish', 'supplies')),
  product_name text not null,
  variety text not null default '',
  quantity numeric(12, 3) not null default 0,
  updated_at timestamptz not null default now(),
  unique (user_id, item_type, product_name, variety)
);
create index if not exists stock_mortality_user_id_idx on stock_mortality (user_id);
