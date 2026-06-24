// Mirrors the Postgres `game_valuation` view (and the original Excel logic) so the
// DEMO backend produces identical numbers to the live Supabase backend.
//
// tier_score = tz_score(augTeamTZ, homeTeamTZ)
//            + augTeam.yougov + opponent.yougov
//            + augTeam.impression_rank
// tier  = bucket(tier_score) ; cpm = tiers[tier]
// impressions = augTeam.impression_estimate * logo_placements_per_game
// game_cost   = cpm/1000 * impressions

export function buildRefs(seed) {
  const teams = {}
  for (const t of seed.teams) teams[t.full_name] = t
  const tz = {}
  for (const m of seed.tz_matrix) tz[`${m.aug_tz}|${m.home_tz}`] = m.score
  const tiers = [...seed.tiers].sort((a, b) => b.score_lo - a.score_lo)
  return { teams, tz, tiers, settings: seed.settings }
}

function tierFor(score, tiers) {
  for (const t of tiers) if (score >= t.score_lo && score <= t.score_hi) return t
  return null
}

export function valuate(game, refs) {
  const { teams, tz, tiers, settings } = refs
  const home = teams[game.home_team]
  const away = teams[game.away_team]
  if (!home || !away) return null

  // Determine augmented side: home if it's ours & carries a feed, else away.
  let augSide = null
  const homeFeed = game.home_rsn && game.home_rsn !== '-'
  const awayFeed = game.away_rsn && game.away_rsn !== '-'
  if (home.is_augmentation_team && homeFeed) augSide = 'home'
  else if (away.is_augmentation_team && awayFeed) augSide = 'away'
  else if (home.is_augmentation_team) augSide = 'home'
  else if (away.is_augmentation_team) augSide = 'away'
  if (!augSide) return null

  const aug = augSide === 'home' ? home : away
  const opp = augSide === 'home' ? away : home
  const homeTz = home.timezone
  const tzScore = tz[`${aug.timezone}|${homeTz}`] ?? 0

  const tierScore =
    tzScore + (aug.yougov_popularity || 0) + (opp.yougov_popularity || 0) + (aug.impression_rank || 0)

  const tier = tierFor(tierScore, tiers)
  const placements = settings.logo_placements_per_game || 10
  const impressions = Math.round((aug.impression_estimate || 0) * placements)
  const cpm = tier ? tier.cpm : 0
  const gameCost = Math.round(((cpm / 1000) * impressions) * 100) / 100

  return {
    aug_side: augSide,
    aug_team: aug.full_name,
    opp_team: opp.full_name,
    tz_score: tzScore,
    tier_score: tierScore,
    tier: tier ? tier.tier : 'Out of Range',
    cpm,
    impressions,
    game_cost: gameCost,
  }
}

export function valuateAll(games, refs) {
  return games
    .map((g) => {
      const v = valuate(g, refs)
      return v ? { ...g, ...v } : null
    })
    .filter(Boolean)
}
