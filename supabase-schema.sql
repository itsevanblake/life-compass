-- Life Compass sync schema.
-- Paste this whole file into Supabase's SQL Editor (Dashboard -> SQL Editor
-- -> New query) and run it once, after creating your project. This can be
-- the SAME Supabase project you already use for the habit tracker plugin —
-- this just adds a separate table.

create table if not exists public.life_compass_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{"vision": {}, "outcomes": [], "quarters": [], "currentQuarterId": null}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.life_compass_data enable row level security;

-- Each signed-in user can only ever read or write their own row.
create policy "select own life compass data"
  on public.life_compass_data for select
  using (auth.uid() = user_id);

create policy "insert own life compass data"
  on public.life_compass_data for insert
  with check (auth.uid() = user_id);

create policy "update own life compass data"
  on public.life_compass_data for update
  using (auth.uid() = user_id);

-- Required for realtime UPDATE events to actually push to subscribed
-- clients (Supabase realtime only broadcasts changes for tables added to
-- this publication).
alter publication supabase_realtime add table public.life_compass_data;
