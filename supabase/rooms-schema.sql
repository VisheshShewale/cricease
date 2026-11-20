create table if not exists public.rooms (
  code text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.rooms enable row level security;
