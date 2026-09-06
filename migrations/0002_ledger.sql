-- The Discus Den ledger
create table if not exists purchases (
  id serial primary key,
  user_id text not null,
  occurred_on date not null,
  supplier text not null,
  item_type text not null check (item_type in ('live_fish', 'supplies')),
  product_name text not null,
  variety text,
  quantity numeric(12, 3) not null,
  unit_cost numeric(12, 2) not null,
  shipping_cost numeric(12, 2) not null default 0,
  mortality_count numeric(12, 3) not null default 0,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists purchases_user_id_idx on purchases (user_id);
create index if not exists purchases_user_date_idx on purchases (user_id, occurred_on desc);

create table if not exists sales (
  id serial primary key,
  user_id text not null,
  occurred_on date not null,
  customer_name text not null,
  item_type text not null check (item_type in ('live_fish', 'supplies')),
  product_name text not null,
  variety text,
  quantity numeric(12, 3) not null,
  unit_cost numeric(12, 2) not null,
  unit_price numeric(12, 2) not null,
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists sales_user_id_idx on sales (user_id);
create index if not exists sales_user_date_idx on sales (user_id, occurred_on desc);
