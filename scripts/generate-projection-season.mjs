/**
 * Build the 2027 projection slate: full NBA season (mid-Oct → mid-Apr).
 * Outputs: supabase/projection_games.sql
 *
 * Regenerate: node scripts/generate-projection-season.mjs
 */
import { readFileSync, writeFileSync } from 'fs'
import { buildProjectionSeason } from '../src/lib/projection.js'

const root = new URL('..', import.meta.url)
const seed = JSON.parse(readFileSync(new URL('./src/seed.json', root)))

function sqlStr(v) {
  if (v == null) return 'null'
  return `'${String(v).replace(/'/g, "''")}'`
}

function sqlBool(v) {
  return v ? 'true' : 'false'
}

const projectionGames = buildProjectionSeason(seed.games)

const lines = [
  '-- AUTO-GENERATED 2027 projection slate (full season Oct 15 2026 – Apr 14 2027)',
  '-- Regenerate: node scripts/generate-projection-season.mjs',
  'begin;',
  'truncate games_projection restart identity cascade;',
  '',
  'insert into games_projection(game_date,game_time_et,day_of_week,home_team,away_team,home_rsn,away_rsn,national_share,national_exclusive,status,brand_contact) values',
]

const rows = projectionGames.map(
  (g) =>
    `(${sqlStr(g.game_date)}, ${sqlStr(g.game_time_et)}, ${sqlStr(g.day_of_week)}, ` +
    `${sqlStr(g.home_team)}, ${sqlStr(g.away_team)}, ${sqlStr(g.home_rsn)}, ${sqlStr(g.away_rsn)}, ` +
    `${sqlBool(g.national_share)}, ${sqlBool(g.national_exclusive)}, 'Open', null)`,
)
lines.push(rows.join(',\n') + ';')
lines.push('', 'commit;', '')

writeFileSync(new URL('./supabase/projection_games.sql', root), lines.join('\n'))

const byMonth = {}
for (const g of projectionGames) {
  const m = g.game_date.slice(0, 7)
  byMonth[m] = (byMonth[m] || 0) + 1
}
console.log(`Wrote ${projectionGames.length} projection games to supabase/projection_games.sql`)
console.log('Date range:', projectionGames[0].game_date, '→', projectionGames.at(-1).game_date)
console.log('By month:', byMonth)
