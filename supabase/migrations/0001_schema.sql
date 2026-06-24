-- ============================================================================
-- NBA Augmentation Model & Inventory — Postgres / Supabase schema
-- Replaces the "FINAL R2_NBA Augmentation Model & Inventory" Excel workbook.
-- Single source of truth for: team reference data, the game schedule,
-- inventory/sales status, the tier-based valuation logic, and saved packages.
-- ============================================================================

-- ---------- Reference: teams -------------------------------------------------
create table if not exists teams (
  id                 bigint generated always as identity primary key,
  short_name         text not null,                       -- "Warriors"
  full_name          text not null unique,                -- "Golden State Warriors"
  broadcaster        text,                                -- NBC RSNs / FanDuel Sports Network / YES Network / N/A
  timezone           text check (timezone in ('Eastern','Central','Mountain','Pacific')),
  dma_market         text,
  dma_population     bigint,
  impression_rank    int,                                 -- 1..30 (by DMA size; non-aug teams = 1)
  yougov_popularity  int,                                 -- YouGov popularity score
  impression_estimate numeric,                            -- modeled per-game impression estimate
  base_score         int,
  is_augmentation_team boolean not null default false     -- true = we can run augmentation on this team
);

-- ---------- Reference: timezone matchup matrix -------------------------------
-- Score contribution based on (augmented team TZ, home team TZ).
create table if not exists tz_matrix (
  aug_tz   text not null,
  home_tz  text not null,
  score    int  not null,
  primary key (aug_tz, home_tz)
);

-- ---------- Reference: tier thresholds & CPM ---------------------------------
create table if not exists tiers (
  tier        text primary key,                           -- 'Tier 1'..'Tier 4'
  score_lo    int  not null,
  score_hi    int  not null,
  cpm         numeric not null
);

-- ---------- Reference: model settings ----------------------------------------
create table if not exists settings (
  key    text primary key,
  value  numeric not null
);

-- ---------- Schedule + inventory (the daily-updated grid) --------------------
create type game_status as enum ('Open','Pitched','Sold','Closed','N/A');

create table if not exists games (
  id            bigint generated always as identity primary key,
  game_date     date not null,
  game_time_et  time,
  day_of_week   text,
  home_team     text not null references teams(full_name),
  away_team     text not null references teams(full_name),
  home_rsn      text,                                     -- '-' or RSN code when our feed carries it
  away_rsn      text,
  national_share     boolean default false,
  national_exclusive boolean default false,               -- flexed to national -> local inventory lost
  status        game_status not null default 'Open',
  brand_contact text,                                     -- advertiser / salesperson when pitched/sold
  notes         text,
  updated_at    timestamptz not null default now()
);
create index if not exists games_date_idx on games (game_date);
create index if not exists games_status_idx on games (status);

-- keep updated_at fresh
create or replace function touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end; $$ language plpgsql;
drop trigger if exists games_touch on games;
create trigger games_touch before update on games
  for each row execute function touch_updated_at();

-- ---------- Saved packages ---------------------------------------------------
create table if not exists packages (
  id                 bigint generated always as identity primary key,
  name               text not null,
  advertiser         text,
  target_impressions numeric default 14000000,
  created_at         timestamptz not null default now()
);

create table if not exists package_games (
  package_id bigint not null references packages(id) on delete cascade,
  game_id    bigint not null references games(id) on delete cascade,
  primary key (package_id, game_id)
);

-- ============================================================================
-- VALUATION VIEW — the heart of the old Matchup Valuation / Package tabs.
-- For each game we determine the "augmented" side (the team we can run on),
-- then compute: timezone score + (aug + opponent YouGov) + aug impression rank
-- -> tier score -> tier -> CPM -> impressions (reach * logo placements) -> cost.
-- ============================================================================
create or replace view game_valuation as
with placements as (
  select value as per_game_logo from settings where key = 'logo_placements_per_game'
),
resolved as (
  select
    g.*,
    -- augmented side: prefer the home team if it's one of ours & carries a feed,
    -- otherwise the away team.
    case
      when ht.is_augmentation_team and coalesce(g.home_rsn,'-') <> '-' then 'home'
      when at.is_augmentation_team and coalesce(g.away_rsn,'-') <> '-' then 'away'
      when ht.is_augmentation_team then 'home'
      when at.is_augmentation_team then 'away'
      else null
    end as aug_side,
    ht.timezone as home_tz,
    ht.is_augmentation_team as home_is_aug,
    at.is_augmentation_team as away_is_aug,
    ht.yougov_popularity as home_pop, at.yougov_popularity as away_pop,
    ht.impression_rank   as home_rank, at.impression_rank   as away_rank,
    ht.impression_estimate as home_impr, at.impression_estimate as away_impr,
    ht.timezone as home_team_tz, at.timezone as away_team_tz
  from games g
  join teams ht on ht.full_name = g.home_team
  join teams at on at.full_name = g.away_team
),
scored as (
  select
    r.*,
    case when aug_side = 'home' then home_team else away_team end as aug_team,
    case when aug_side = 'home' then away_team else home_team end as opp_team,
    case when aug_side = 'home' then home_pop  else away_pop  end as aug_pop,
    case when aug_side = 'home' then away_pop  else home_pop  end as opp_pop,
    case when aug_side = 'home' then home_rank else away_rank end as aug_rank,
    case when aug_side = 'home' then home_impr else away_impr end as aug_impr,
    case when aug_side = 'home' then home_team_tz else away_team_tz end as aug_tz
  from resolved r
),
tz as (
  select s.*,
    coalesce((select m.score from tz_matrix m
              where m.aug_tz = s.aug_tz and m.home_tz = s.home_tz), 0) as tz_score
  from scored s
),
final as (
  select t.*,
    (t.tz_score + coalesce(t.aug_pop,0) + coalesce(t.opp_pop,0) + coalesce(t.aug_rank,0)) as tier_score
  from tz t
)
select
  f.id, f.game_date, f.game_time_et, f.day_of_week,
  f.home_team, f.away_team, f.home_rsn, f.away_rsn,
  f.status, f.brand_contact, f.national_exclusive,
  f.aug_side, f.aug_team, f.opp_team,
  f.tz_score, f.aug_pop, f.opp_pop, f.aug_rank,
  f.tier_score,
  tr.tier,
  tr.cpm,
  round(coalesce(f.aug_impr,0) * (select per_game_logo from placements)) as impressions,
  round( (tr.cpm / 1000.0) * (coalesce(f.aug_impr,0) * (select per_game_logo from placements)) , 2) as game_cost
from final f
left join tiers tr
  on f.tier_score between tr.score_lo and tr.score_hi
where f.aug_side is not null;

-- Convenience: package roll-up (blended CPM, totals) matching the Excel summary.
create or replace view package_summary as
select
  p.id as package_id, p.name, p.advertiser, p.target_impressions,
  count(v.id)                                   as games,
  coalesce(sum(v.impressions),0)                as total_impressions,
  coalesce(sum(v.game_cost),0)                  as total_cost,
  case when coalesce(sum(v.impressions),0)=0 then 0
       else round( coalesce(sum(v.game_cost),0) / sum(v.impressions) * 1000, 2) end as blended_cpm,
  case when count(v.id)=0 then 0
       else round( coalesce(sum(v.game_cost),0) / count(v.id), 2) end as avg_cost_per_game,
  min(v.game_date) as flight_start, max(v.game_date) as flight_end
from packages p
left join package_games pg on pg.package_id = p.id
left join game_valuation v on v.id = pg.game_id
group by p.id;
