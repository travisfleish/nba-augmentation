const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

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

/** Demo view: next-season schedule with fresh inventory (all Open, no contacts). */
export function projectGamesFor2027(games) {
  return games.map((g) => {
    const { game_date, day_of_week } = shiftGameDate(g.game_date, 1)
    return {
      ...g,
      game_date,
      day_of_week,
      status: 'Open',
      brand_contact: null,
    }
  })
}
