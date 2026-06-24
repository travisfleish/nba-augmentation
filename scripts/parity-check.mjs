import { readFileSync } from 'fs'
import { buildRefs, valuate, valuateAll } from './src/lib/valuation.js'
const seed = JSON.parse(readFileSync(new URL('./src/seed.json', import.meta.url)))
const refs = buildRefs(seed)
const test = { home_team:'Los Angeles Clippers', away_team:'Golden State Warriors', home_rsn:'-', away_rsn:'NBCSCA' }
console.log('Warriors@Clippers ->', valuate(test, refs))
const all = valuateAll(seed.games, refs)
const byTier = {}; for (const g of all) byTier[g.tier]=(byTier[g.tier]||0)+1
console.log('valuated:', all.length,'/',seed.games.length,'| tiers:', byTier)
const pick = all.filter(g=>g.cpm>0).slice(0,2)
const ti=pick.reduce((s,g)=>s+g.impressions,0), tc=pick.reduce((s,g)=>s+g.game_cost,0)
console.log('2-game pkg -> impr:',ti,'cost:',tc.toFixed(2),'blendedCPM:',(tc/ti*1000).toFixed(2))
