// Backend abstraction. Uses live Supabase when env vars are present,
// otherwise an in-memory DEMO backend off the bundled seed so the app
// runs with zero setup. Both return identical shapes.
import { createClient } from '@supabase/supabase-js'
import seed from '../seed.json'
import { buildRefs, valuateAll } from './valuation.js'
import { buildProjectionSeason } from './projection.js'

const URL = import.meta.env.VITE_SUPABASE_URL
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY
export const MODE = URL && KEY ? 'supabase' : 'demo'

const supabase = MODE === 'supabase' ? createClient(URL, KEY) : null

const WESTERN = new Set([
  'Golden State Warriors', 'Sacramento Kings', 'Los Angeles Clippers',
  'Minnesota Timberwolves', 'San Antonio Spurs', 'Los Angeles Lakers',
  'Houston Rockets', 'Utah Jazz', 'Phoenix Suns', 'Portland Trail Blazers',
  'Dallas Mavericks', 'Denver Nuggets', 'Oklahoma City Thunder',
  'Memphis Grizzlies', 'New Orleans Pelicans',
])

function teamConference(fullName) {
  return WESTERN.has(fullName) ? 'Western' : 'Eastern'
}

function enrichGames(rows) {
  return rows.map((g) => ({
    ...g,
    aug_conference: teamConference(g.aug_team),
    aug_timezone: seed.teams.find((t) => t.full_name === g.aug_team)?.timezone ?? null,
  }))
}

// ---------------- DEMO backend (in-memory) ----------------
const refs = buildRefs(seed)
let demoGames = structuredClone(seed.games)
let demoPackages = []
let demoPkgId = 1
let demoProjection = true

const demo = {
  async teams() {
    return seed.teams.map((t) => ({ ...t, conference: teamConference(t.full_name) }))
  },
  async getProjectionMode() {
    return demoProjection
  },
  async setProjectionMode(enabled) {
    demoProjection = enabled
  },
  async valuatedGames() {
    const source = demoProjection ? buildProjectionSeason(demoGames) : demoGames
    const rows = valuateAll(source, refs).sort((a, b) =>
      a.game_date.localeCompare(b.game_date) || (a.game_time_et || '').localeCompare(b.game_time_et || '')
    )
    return enrichGames(rows)
  },
  async updateGame(id, patch) {
    const g = demoGames.find((x) => x.id === id)
    if (g) Object.assign(g, patch)
    return g
  },
  async savePackage(name, advertiser, gameIds) {
    const pkg = { id: demoPkgId++, name, advertiser, game_ids: [...gameIds], created_at: new Date().toISOString() }
    demoPackages.push(pkg)
    return pkg
  },
  async packages() {
    return demoPackages
  },
}

// ---------------- Supabase backend ----------------
const live = {
  async teams() {
    const { data, error } = await supabase.from('teams').select('*').order('impression_rank', { ascending: false })
    if (error) throw error
    return data
  },
  async getProjectionMode() {
    const { data, error } = await supabase
      .from('settings')
      .select('value')
      .eq('key', 'projection_2027_enabled')
      .maybeSingle()
    if (error) throw error
    return data == null ? true : Number(data?.value) === 1
  },
  async setProjectionMode(enabled) {
    const { error } = await supabase
      .from('settings')
      .upsert({ key: 'projection_2027_enabled', value: enabled ? 1 : 0 }, { onConflict: 'key' })
    if (error) throw error
  },
  async valuatedGames() {
    const projection = await this.getProjectionMode()
    const view = projection ? 'inventory_catalog_projection' : 'inventory_catalog'
    const { data, error } = await supabase
      .from(view)
      .select('*')
      .order('game_date')
      .limit(2000)
    if (error) throw error
    return data
  },
  async updateGame(id, patch) {
    const { data, error } = await supabase.from('games').update(patch).eq('id', id).select().single()
    if (error) throw error
    return data
  },
  async savePackage(name, advertiser, gameIds) {
    const { data: pkg, error } = await supabase
      .from('packages')
      .insert({ name, advertiser })
      .select()
      .single()
    if (error) throw error
    const rows = gameIds.map((gid) => ({ package_id: pkg.id, game_id: gid }))
    const { error: e2 } = await supabase.from('package_games').insert(rows)
    if (e2) throw e2
    return pkg
  },
  async packages() {
    const { data, error } = await supabase.from('package_summary').select('*').order('package_id', { ascending: false })
    if (error) throw error
    return data
  },
}

export const db = MODE === 'supabase' ? live : demo
