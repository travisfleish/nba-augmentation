const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Last season partial slate (new product launch). */
export const SOURCE_START = '2026-01-01'
export const SOURCE_END = '2026-04-12'

/** Full 2027 projection season (mid-Oct → mid-Apr). */
export const SEASON_START = '2026-10-15'
export const SEASON_END = '2027-04-14'
export const TARGET_TOTAL = 920

/** Shift YYYY-MM-DD forward by whole calendar years; recompute day_of_week. */
export function shiftGameDate(dateStr, years = 1) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y + years, m - 1, d)
  const game_date = [
    dt.getFullYear(),
    String(dt.getMonth() + 1).padStart(2, '0'),
    String(dt.getDate()).padStart(2, '0'),
  ].join('-')
  return { game_date, day_of_week: DAYS[dt.getDay()] }
}

function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function formatDate(d) {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-')
}

function dayOfWeek(d) {
  return DAYS[d.getDay()]
}

function remapDate(dateStr) {
  const srcStart = parseDate(SOURCE_START).getTime()
  const srcEnd = parseDate(SOURCE_END).getTime()
  const dstStart = parseDate(SEASON_START).getTime()
  const dstEnd = parseDate(SEASON_END).getTime()
  const t = parseDate(dateStr).getTime()
  const ratio = (t - srcStart) / (srcEnd - srcStart)
  return new Date(dstStart + ratio * (dstEnd - dstStart))
}

/** Deterministic pseudo-random 0..1 from a string seed. */
function hash01(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return ((h >>> 0) % 10000) / 10000
}

function enumerateDates(start, end) {
  const out = []
  const d = parseDate(start)
  const last = parseDate(end)
  while (d <= last) {
    out.push(formatDate(d))
    d.setDate(d.getDate() + 1)
  }
  return out
}

/**
 * Build the upcoming 2027 slate: remap last season across a full Oct–Apr window,
 * then fill to ~full-season density using existing matchup patterns.
 */
export function buildProjectionSeason(games) {
  const remapped = games.map((g) => {
    const dt = remapDate(g.game_date)
    return {
      ...g,
      game_date: formatDate(dt),
      day_of_week: dayOfWeek(dt),
      status: 'Open',
      brand_contact: null,
    }
  })

  const byDate = new Map()
  for (const g of remapped) {
    if (!byDate.has(g.game_date)) byDate.set(g.game_date, [])
    byDate.get(g.game_date).push(g)
  }

  const fillers = []
  const seasonDates = enumerateDates(SEASON_START, SEASON_END)
  const templates = games.filter((g) => g.status !== 'N/A')

  for (const date of seasonDates) {
    const target = Math.max(4, Math.round(5.2 + hash01(date) * 2))
    const have = byDate.get(date)?.length ?? 0
    let need = target - have
    while (need > 0) {
      const tpl = templates[Math.floor(hash01(`${date}-${need}`) * templates.length)]
      const slot = Math.floor(hash01(`${date}-slot-${need}`) * 4)
      const times = ['19:00', '19:30', '20:00', '22:00', '22:30']
      const time = times[(slot + need) % times.length]
      const homeFirst = hash01(`${date}-home-${need}`) > 0.5
      fillers.push({
        game_date: date,
        game_time_et: tpl.game_time_et || time,
        day_of_week: dayOfWeek(parseDate(date)),
        home_team: homeFirst ? tpl.home_team : tpl.away_team,
        away_team: homeFirst ? tpl.away_team : tpl.home_team,
        home_rsn: homeFirst ? tpl.home_rsn : tpl.away_rsn,
        away_rsn: homeFirst ? tpl.away_rsn : tpl.home_rsn,
        national_share: tpl.national_share,
        national_exclusive: tpl.national_exclusive,
        status: 'Open',
        brand_contact: null,
      })
      if (!byDate.has(date)) byDate.set(date, [])
      byDate.get(date).push(fillers.at(-1))
      need--
    }
  }

  const maxFillers = Math.max(0, TARGET_TOTAL - remapped.length)
  return [...remapped, ...fillers.slice(0, maxFillers)].sort(
    (a, b) =>
      a.game_date.localeCompare(b.game_date) ||
      (a.game_time_et || '').localeCompare(b.game_time_et || ''),
  )
}

/** Demo / client view: full 2027 season with fresh inventory. */
export function projectGamesFor2027(games) {
  return buildProjectionSeason(games)
}
