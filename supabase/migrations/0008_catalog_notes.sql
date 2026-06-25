-- Expose schedule notes through catalog views (Manual Updates tab).

create or replace view game_valuation as
with placements as (
  select value as per_game_logo from settings where key = 'logo_placements_per_game'
),
resolved as (
  select
    g.*,
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
  f.status, f.brand_contact, f.national_exclusive, f.notes,
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

create or replace view game_valuation_projection as
with placements as (
  select value as per_game_logo from settings where key = 'logo_placements_per_game'
),
resolved as (
  select
    g.*,
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
  from games_projection g
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
  f.status, f.brand_contact, f.national_exclusive, f.notes,
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

create or replace view inventory_catalog_projection as
select
  v.id,
  v.game_date,
  v.game_time_et,
  trim(to_char(v.game_date, 'Dy')) as day_of_week,
  v.home_team,
  v.away_team,
  v.home_rsn,
  v.away_rsn,
  'Open'::game_status as status,
  null::text as brand_contact,
  v.national_exclusive,
  v.notes,
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
  aug.conference as aug_conference,
  aug.timezone   as aug_timezone,
  aug.dma_market as aug_dma_market
from game_valuation_projection v
join teams aug on aug.full_name = v.aug_team;
