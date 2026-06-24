-- Prototype RLS: allow the anon key to read everything and edit inventory/packages.
-- Tighten before any real/production use (e.g. require authenticated role).
alter table teams         enable row level security;
alter table games         enable row level security;
alter table tiers         enable row level security;
alter table tz_matrix     enable row level security;
alter table settings      enable row level security;
alter table packages      enable row level security;
alter table package_games enable row level security;

-- read-only reference tables
create policy "read teams"     on teams     for select using (true);
create policy "read tiers"     on tiers     for select using (true);
create policy "read tz"        on tz_matrix for select using (true);
create policy "read settings"  on settings  for select using (true);

-- games: read + update status/contact (prototype: full write)
create policy "read games"     on games     for select using (true);
create policy "write games"    on games     for update using (true) with check (true);
create policy "insert games"   on games     for insert with check (true);

-- packages: full CRUD for the prototype
create policy "rw packages"     on packages     for all using (true) with check (true);
create policy "rw package_games" on package_games for all using (true) with check (true);
