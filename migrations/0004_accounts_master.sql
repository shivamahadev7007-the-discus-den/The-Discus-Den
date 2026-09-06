create table if not exists accounts_master (
  id serial primary key,
  user_id text not null,
  supplier text not null,
  item_kind text not null,
  variety text not null,
  purchased_on date not null,
  quantity_bought numeric(12, 3) not null,
  unit_cost numeric(12, 2) not null,
  total_purchase_cost numeric(12, 2) not null,
  mortality_count numeric(12, 3),
  quantity_sold numeric(12, 3),
  current_stock numeric(12, 3),
  sale_price numeric(12, 2),
  total_sale_revenue numeric(12, 2),
  total_profit numeric(12, 2),
  created_at timestamptz not null default now()
);
create index if not exists accounts_master_user_id_idx on accounts_master (user_id);
create index if not exists accounts_master_user_date_idx on accounts_master (user_id, purchased_on desc);
