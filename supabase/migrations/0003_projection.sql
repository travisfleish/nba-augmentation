-- 2027 projection mode + enriched inventory views for MCP filtering.

alter table teams
  add column if not exists conference text check (conference in ('Western', 'Eastern'));

update teams set conference = 'Western' where short_name in (
  'Warriors', 'Kings', 'LA Clippers', 'Timberwolves', 'Spurs', 'LA Lakers',
  'Rockets', 'Jazz', 'Suns', 'Trail Blazers', 'Mavericks', 'Nuggets',
  'Thunder', 'Grizzlies', 'Pelicans'
);
update teams set conference = 'Eastern' where conference is null;

insert into settings(key, value) values ('projection_2027_enabled', 1)
on conflict (key) do nothing;

-- Aug-team metadata for conference / timezone filters (MCP, RFP-style queries).
create or replace view inventory_catalog as
select
  v.*,
  aug.conference as aug_conference,
  aug.timezone   as aug_timezone,
  aug.dma_market as aug_dma_market
from game_valuation v
join teams aug on aug.full_name = v.aug_team;

-- Next-season demo: +1 year on dates, all inventory Open, contacts cleared.
create or replace view inventory_catalog_projection as
select
  v.id,
  (v.game_date + interval '1 year')::date as game_date,
  v.game_time_et,
  trim(to_char((v.game_date + interval '1 year')::date, 'Dy')) as day_of_week,
  v.home_team,
  v.away_team,
  v.home_rsn,
  v.away_rsn,
  'Open'::game_status as status,
  null::text as brand_contact,
  v.national_exclusive,
  v.aug_side,
  v.aug_team,
  v.opp_team,
  v.tz_score,
  v.aug_pop,
  v.opp_pop,
  v.aug_rank,
  v.tier_score,
  v.tier,
  v.cpm,
  v.impressions,
  v.game_cost,
  v.aug_conference,
  v.aug_timezone,
  v.aug_dma_market
from inventory_catalog v;

-- Allow the prototype app to flip projection mode from the UI.
create policy "write settings" on settings for update using (true) with check (true);
create policy "insert settings" on settings for insert with check (true);
