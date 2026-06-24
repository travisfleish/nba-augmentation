// Backend abstraction. Uses live Supabase when env vars are present,
// otherwise an in-memory DEMO backend off the bundled seed so the app
// runs with zero setup. Both return identical shapes.
import { createClient } from '@supabase/supabase-js'
import seed from '../seed.json'
import { buildRefs, valuateAll } from './valuation.js'

const URL = import.meta.env.VITE_SUPABASE_URL
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY
export const MODE = URL && KEY ? 'supabase' : 'demo'

const supabase = MODE === 'supabase' ? createClient(URL, KEY) : null

// ---------------- DEMO backend (in-memory) ----------------
const refs = buildRefs(seed)
let demoGames = structuredClone(seed.games)
let demoPackages = []
let demoPkgId = 1

const demo = {
  async teams() {
    return seed.teams
  },
  async valuatedGames() {
    return valuateAll(demoGames, refs).sort((a, b) =>
      a.game_date.localeCompare(b.game_date) || (a.game_time_et || '').localeCompare(b.game_time_et || '')
    )
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
  async valuatedGames() {
    const { data, error } = await supabase
      .from('game_valuation')
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
