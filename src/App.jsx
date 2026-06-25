import { useEffect, useMemo, useState } from 'react'
import { db, MODE } from './lib/data.js'
import Logo from './components/brand/Logo.jsx'
import ManualUpdates from './components/ManualUpdates.jsx'

const STATUSES = ['Open', 'Pitched', 'Sold', 'Closed', 'N/A']
const TIER_ORDER = { 'Tier 1': 1, 'Tier 2': 2, 'Tier 3': 3, 'Tier 4': 4, 'Out of Range': 5 }
const STATUS_ORDER = { Open: 0, Pitched: 1, Sold: 2, Closed: 3, 'N/A': 4 }
const NUMERIC_SORT_KEYS = new Set(['tier_score', 'cpm', 'impressions', 'game_cost'])

const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'))
const usd = (n) => (n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }))
const usd2 = (n) => (n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))

export default function App() {
  const [tab, setTab] = useState('inventory')
  const [rawGames, setRawGames] = useState([])
  const [teams, setTeams] = useState([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState(null)
  const [projection2027, setProjection2027] = useState(false)
  const [projectionOverrides, setProjectionOverrides] = useState(() => new Map())

  // filters
  const [team, setTeam] = useState('All')
  const [status, setStatus] = useState('All')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  // package selection
  const [picked, setPicked] = useState(() => new Set())
  const [pkgName, setPkgName] = useState('')
  const [pkgAdv, setPkgAdv] = useState('')

  async function refresh() {
    const [g, t, proj] = await Promise.all([db.valuatedGames(), db.teams(), db.getProjectionMode()])
    setRawGames(g)
    setTeams(t)
    setProjection2027(proj)
    setLoading(false)
  }
  useEffect(() => {
    refresh()
  }, [])

  useEffect(() => {
    setProjectionOverrides(new Map())
  }, [projection2027])

  const games = useMemo(() => {
    if (!projection2027 || projectionOverrides.size === 0) return rawGames
    return rawGames.map((g) => {
      const patch = projectionOverrides.get(g.id)
      return patch ? { ...g, ...patch } : g
    })
  }, [rawGames, projection2027, projectionOverrides])

  async function toggleProjection(enabled) {
    try {
      await db.setProjectionMode(enabled)
      setProjectionOverrides(new Map())
      if (enabled) setStatus('All')
      await refresh()
      if (enabled) {
        flash('Upcoming 2027 season (Oct–Apr) — all games Open. Status edits are local-only.')
      }
    } catch (e) {
      flash('Could not update projection mode: ' + e.message)
    }
  }

  function flash(msg) {
    setToast(msg)
    setTimeout(() => setToast(null), 2200)
  }

  const augTeams = useMemo(
    () => teams.filter((t) => t.is_augmentation_team).map((t) => t.full_name).sort(),
    [teams]
  )

  const filtered = useMemo(() => {
    return games.filter((g) => {
      if (team !== 'All' && g.aug_team !== team && g.home_team !== team && g.away_team !== team) return false
      if (status !== 'All' && g.status !== status) return false
      if (from && g.game_date < from) return false
      if (to && g.game_date > to) return false
      return true
    })
  }, [games, team, status, from, to])

  async function setGameField(id, patch) {
    if (projection2027) {
      setProjectionOverrides((prev) => {
        const next = new Map(prev)
        next.set(id, { ...next.get(id), ...patch })
        return next
      })
      return
    }
    setRawGames((gs) => gs.map((g) => (g.id === id ? { ...g, ...patch } : g)))
    try {
      await db.updateGame(id, patch)
    } catch (e) {
      flash('Save failed: ' + e.message)
    }
  }

  const pickedGames = useMemo(() => filtered.filter((g) => picked.has(g.id)), [filtered, picked])
  // include picked games even if filtered out, for the summary
  const allPicked = useMemo(() => games.filter((g) => picked.has(g.id)), [games, picked])

  const summary = useMemo(() => {
    const n = allPicked.length
    const totalImpr = allPicked.reduce((s, g) => s + (g.impressions || 0), 0)
    const totalCost = allPicked.reduce((s, g) => s + (g.game_cost || 0), 0)
    const blended = totalImpr ? (totalCost / totalImpr) * 1000 : 0
    const dates = allPicked.map((g) => g.game_date).sort()
    return {
      n,
      totalImpr,
      totalCost,
      blended,
      avg: n ? totalCost / n : 0,
      flight: n ? `${dates[0]} → ${dates[dates.length - 1]}` : '—',
    }
  }, [allPicked])

  const TARGET = 14000000

  async function savePackage() {
    if (!pkgName || allPicked.length === 0) return
    try {
      await db.savePackage(pkgName, pkgAdv, [...picked])
      flash(`Saved “${pkgName}” (${allPicked.length} games)`)
      setPicked(new Set())
      setPkgName('')
      setPkgAdv('')
    } catch (e) {
      flash('Save failed: ' + e.message)
    }
  }

  function togglePick(id) {
    setPicked((p) => {
      const n = new Set(p)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }

  return (
    <div className="app">
      <header className="top">
        <div className="brand-lockup">
          <Logo variant="horizontal" color="white" />
          <h1>NBA Augmentation — Inventory & Valuation</h1>
        </div>
        <span className={`badge ${MODE === 'supabase' ? 'live' : 'demo'}`}>
          {MODE === 'supabase' ? 'LIVE · Supabase' : 'DEMO · local seed'}
        </span>
        {projection2027 && <span className="badge projection">Upcoming · 2027</span>}
        {!projection2027 && <span className="badge demo">Last season · 2026</span>}
        <label className="projection-toggle" title="Switch between last season (actual statuses) and upcoming 2027 (all Open)">
          <span className={!projection2027 ? 'active' : ''}>Last season (2026)</span>
          <button
            type="button"
            role="switch"
            aria-checked={projection2027}
            className={`toggle ${projection2027 ? 'on' : ''}`}
            onClick={() => toggleProjection(!projection2027)}
          >
            <span className="toggle-knob" />
          </button>
          <span className={projection2027 ? 'active' : ''}>Upcoming (2027)</span>
        </label>
        <span className="spacer" />
        <span className="sub">{games.length} augmentable games · {augTeams.length} active teams</span>
      </header>

      <div className="tabs">
        <button className={tab === 'inventory' ? 'active' : ''} onClick={() => setTab('inventory')}>
          Inventory
        </button>
        <button className={tab === 'package' ? 'active' : ''} onClick={() => setTab('package')}>
          Package Builder
        </button>
        <button className={tab === 'manual' ? 'active' : ''} onClick={() => setTab('manual')}>
          Manual Updates
        </button>
      </div>

      {tab !== 'manual' && (
        <Filters
          {...{ team, setTeam, status, setStatus, from, setFrom, to, setTo, augTeams }}
          count={filtered.length}
        />
      )}

      {loading ? (
        <div className="card">
          <div className="loading">Loading inventory…</div>
        </div>
      ) : tab === 'inventory' ? (
        <div className="card">
          <Table
            rows={filtered}
            mode="inventory"
            onStatus={(id, v) => setGameField(id, { status: v })}
            onContact={(id, v) => setGameField(id, { brand_contact: v })}
          />
        </div>
      ) : tab === 'package' ? (
        <div className="layout">
          <div className="card">
            <Table
              rows={filtered}
              mode="package"
              picked={picked}
              onPick={togglePick}
            />
          </div>
          <div className="summary">
            <h3>Package Summary</h3>
            <div className="stat"><span>Games</span><span className="v">{summary.n}</span></div>
            <div className="stat"><span>Total impressions</span><span className="v">{fmt(summary.totalImpr)}</span></div>
            <div className="stat"><span>Blended CPM</span><span className="v">{usd2(summary.blended)}</span></div>
            <div className="stat"><span>Avg cost / game</span><span className="v">{usd(summary.avg)}</span></div>
            <div className="stat"><span>Total cost</span><span className="v big">{usd(summary.totalCost)}</span></div>
            <div style={{ marginTop: 12 }}>
              <div className="stat" style={{ border: 'none', paddingBottom: 4 }}>
                <span>vs target ({(TARGET / 1e6).toFixed(0)}M impr)</span>
                <span className="v">{Math.round((summary.totalImpr / TARGET) * 100)}%</span>
              </div>
              <div className="bar"><div style={{ width: Math.min(100, (summary.totalImpr / TARGET) * 100) + '%' }} /></div>
            </div>
            <div className="stat"><span>Flight</span><span className="v" style={{ fontSize: 11 }}>{summary.flight}</span></div>
            <div style={{ marginTop: 16 }}>
              <input placeholder="Package name" value={pkgName} onChange={(e) => setPkgName(e.target.value)} />
              <input placeholder="Advertiser (optional)" value={pkgAdv} onChange={(e) => setPkgAdv(e.target.value)} />
              <button className="btn" disabled={!pkgName || summary.n === 0} onClick={savePackage}>
                Save package
              </button>
              {summary.n > 0 && (
                <button className="btn ghost" onClick={() => setPicked(new Set())}>Clear selection</button>
              )}
            </div>
          </div>
        </div>
      ) : (
        <ManualUpdates
          games={games}
          teams={teams}
          onRefresh={refresh}
          setGameField={setGameField}
          projection2027={projection2027}
          flash={flash}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function Filters({ team, setTeam, status, setStatus, from, setFrom, to, setTo, augTeams, count }) {
  return (
    <div className="filters">
      <div className="field">
        <label>Team</label>
        <select value={team} onChange={(e) => setTeam(e.target.value)}>
          <option>All</option>
          {augTeams.map((t) => <option key={t}>{t}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Status</label>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option>All</option>
          {STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      <div className="field">
        <label>From</label>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </div>
      <div className="field">
        <label>To</label>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      <span className="spacer" />
      <span className="count">{count} games</span>
    </div>
  )
}

function compareRows(a, b, key) {
  switch (key) {
    case 'game_date':
      return a.game_date.localeCompare(b.game_date)
    case 'matchup':
      return `${a.away_team} @ ${a.home_team}`.localeCompare(`${b.away_team} @ ${b.home_team}`)
    case 'aug_team':
      return (a.aug_team || '').localeCompare(b.aug_team || '')
    case 'rsn':
      return rsnFor(a).localeCompare(rsnFor(b))
    case 'tier_score':
      return (a.tier_score || 0) - (b.tier_score || 0)
    case 'tier':
      return (TIER_ORDER[a.tier] ?? 99) - (TIER_ORDER[b.tier] ?? 99)
    case 'cpm':
      return (a.cpm || 0) - (b.cpm || 0)
    case 'impressions':
      return (a.impressions || 0) - (b.impressions || 0)
    case 'game_cost':
      return (a.game_cost || 0) - (b.game_cost || 0)
    case 'status':
      return (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99)
    case 'brand_contact':
      return (a.brand_contact || '').localeCompare(b.brand_contact || '')
    default:
      return 0
  }
}

function rsnFor(g) {
  return (g.aug_side === 'home' ? g.home_rsn : g.away_rsn) || ''
}

function SortTh({ label, sortKey, sortBy, sortDir, onSort, className }) {
  const active = sortBy === sortKey
  return (
    <th className={[className, 'sortable', active && 'sorted'].filter(Boolean).join(' ')}>
      <button type="button" className="th-sort" onClick={() => onSort(sortKey)}>
        {label}
        <span className="sort-icon" aria-hidden="true">
          {active ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </button>
    </th>
  )
}

function Table({ rows, mode, onStatus, onContact, picked, onPick }) {
  const [sortBy, setSortBy] = useState('game_date')
  const [sortDir, setSortDir] = useState('asc')

  function toggleSort(key) {
    if (sortBy === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortBy(key)
      setSortDir(NUMERIC_SORT_KEYS.has(key) ? 'desc' : 'asc')
    }
  }

  const sortedRows = useMemo(() => {
    const next = [...rows]
    next.sort((a, b) => {
      const cmp = compareRows(a, b, sortBy)
      return sortDir === 'asc' ? cmp : -cmp
    })
    return next
  }, [rows, sortBy, sortDir])

  return (
    <div style={{ maxHeight: '64vh', overflow: 'auto' }}>
      <table>
        <thead>
          <tr>
            {mode === 'package' && <th></th>}
            <SortTh label="Date" sortKey="game_date" {...{ sortBy, sortDir, onSort: toggleSort }} />
            <SortTh label="Matchup" sortKey="matchup" {...{ sortBy, sortDir, onSort: toggleSort }} />
            <SortTh label="Aug team" sortKey="aug_team" {...{ sortBy, sortDir, onSort: toggleSort }} />
            <SortTh label="RSN" sortKey="rsn" {...{ sortBy, sortDir, onSort: toggleSort }} />
            <SortTh label="Tier score" sortKey="tier_score" className="num" {...{ sortBy, sortDir, onSort: toggleSort }} />
            <SortTh label="Tier" sortKey="tier" {...{ sortBy, sortDir, onSort: toggleSort }} />
            <SortTh label="CPM" sortKey="cpm" className="num" {...{ sortBy, sortDir, onSort: toggleSort }} />
            <SortTh label="Impressions" sortKey="impressions" className="num" {...{ sortBy, sortDir, onSort: toggleSort }} />
            <SortTh label="Game cost" sortKey="game_cost" className="num" {...{ sortBy, sortDir, onSort: toggleSort }} />
            <SortTh label="Status" sortKey="status" {...{ sortBy, sortDir, onSort: toggleSort }} />
            {mode === 'inventory' && (
              <SortTh label="Brand / contact" sortKey="brand_contact" {...{ sortBy, sortDir, onSort: toggleSort }} />
            )}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((g) => (
            <tr key={g.id}>
              {mode === 'package' && (
                <td>
                  <input
                    type="checkbox"
                    className="pick"
                    checked={picked.has(g.id)}
                    onChange={() => onPick(g.id)}
                  />
                </td>
              )}
              <td className="muted">
                {g.game_date}
                {g.national_exclusive && <span className="flag" title="Flexed to national — local inventory lost"> ⚑</span>}
              </td>
              <td className="matchup">
                {short(g.away_team)} <span className="muted">@</span> {short(g.home_team)}
              </td>
              <td>{short(g.aug_team)}</td>
              <td className="muted">{rsnFor(g) || '—'}</td>
              <td className="num">{g.tier_score}</td>
              <td><span className={`tier ${String(g.tier).replace(' ', '')}`}>{g.tier}</span></td>
              <td className="num">{usd(g.cpm)}</td>
              <td className="num">{fmt(g.impressions)}</td>
              <td className="num">{usd(g.game_cost)}</td>
              <td>
                {mode === 'inventory' ? (
                  <select
                    className={`status ${g.status}`}
                    value={g.status}
                    onChange={(e) => onStatus(g.id, e.target.value)}
                  >
                    {STATUSES.map((s) => <option key={s}>{s}</option>)}
                  </select>
                ) : (
                  <span className={`status ${g.status}`} style={{ border: 'none', padding: 0 }}>{g.status}</span>
                )}
              </td>
              {mode === 'inventory' && (
                <td>
                  <input
                    className="contact"
                    defaultValue={g.brand_contact || ''}
                    placeholder="—"
                    onBlur={(e) => {
                      const v = e.target.value.trim() || null
                      if (v !== (g.brand_contact || null)) onContact(g.id, v)
                    }}
                  />
                </td>
              )}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={12} className="loading">No games match these filters.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function short(full) {
  if (!full) return '—'
  const nick = { 'Portland Trail Blazers': 'Trail Blazers', 'Philadelphia 76ers': '76ers' }
  if (nick[full]) return nick[full]
  const p = full.split(' ')
  return p[p.length - 1]
}
