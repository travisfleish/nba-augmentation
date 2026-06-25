import { useEffect, useId, useMemo, useState } from 'react'
import { db } from '../lib/data.js'

const STATUSES = ['Open', 'Pitched', 'Sold', 'Closed', 'N/A']
const BROADCASTER_PRESETS = ['NBC RSNs', 'FanDuel Sports Network', 'YES Network', 'N/A']
const SECTIONS = [
  { id: 'schedule', label: 'Schedule', excel: 'Full NBA Schedule' },
  { id: 'teams', label: 'Team Data', excel: 'Team Data' },
  { id: 'tiers', label: 'Tiers & CPM', excel: 'Matchup Valuation' },
  { id: 'log', label: 'Change Log', excel: 'Model Changes' },
]

const LOG_KEY = 'nba-aug-manual-changes'

function today() {
  return new Date().toISOString().slice(0, 10)
}

function loadLog() {
  try {
    return JSON.parse(localStorage.getItem(LOG_KEY) || '[]')
  } catch {
    return []
  }
}

function saveLog(entries) {
  localStorage.setItem(LOG_KEY, JSON.stringify(entries))
}

function shortTeam(full) {
  if (!full) return '—'
  const nick = { 'Portland Trail Blazers': 'Trail Blazers', 'Philadelphia 76ers': '76ers' }
  if (nick[full]) return nick[full]
  const p = full.split(' ')
  return p[p.length - 1]
}

export default function ManualUpdates({ games, teams, onRefresh, setGameField, projection2027, flash }) {
  const [section, setSection] = useState('schedule')
  const [tiers, setTiers] = useState([])
  const [settings, setSettings] = useState({})
  const [log, setLog] = useState(loadLog)
  const [scheduleQ, setScheduleQ] = useState('')
  const [noteTab, setNoteTab] = useState('Full NBA Schedule')
  const [noteText, setNoteText] = useState('')
  const [activateTeamId, setActivateTeamId] = useState('')
  const [activateBroadcaster, setActivateBroadcaster] = useState('NBC RSNs')
  const [activateImpressions, setActivateImpressions] = useState('')

  useEffect(() => {
    db.tiers().then(setTiers).catch((e) => flash('Could not load tiers: ' + e.message))
    db.settings().then(setSettings).catch((e) => flash('Could not load settings: ' + e.message))
  }, [])

  function appendLog(entry) {
    const next = [{ id: Date.now(), date: today(), author: 'You', ...entry }, ...log].slice(0, 200)
    setLog(next)
    saveLog(next)
  }

  async function afterModelChange(area, description) {
    appendLog({ tabs: area, description })
    await onRefresh()
    flash('Saved — valuations refreshed')
  }

  const scheduleRows = useMemo(() => {
    const q = scheduleQ.trim().toLowerCase()
    if (!q) return games
    return games.filter((g) =>
      [g.home_team, g.away_team, g.aug_team, g.brand_contact, g.status, g.game_date]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    )
  }, [games, scheduleQ])

  const augTeams = useMemo(
    () => [...teams].filter((t) => t.is_augmentation_team).sort((a, b) => (b.impression_rank || 0) - (a.impression_rank || 0)),
    [teams]
  )

  const inactiveTeams = useMemo(
    () => [...teams].filter((t) => !t.is_augmentation_team).sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [teams]
  )

  const broadcasterOptions = useMemo(() => {
    const fromTeams = teams.map((t) => t.broadcaster).filter(Boolean)
    return [...new Set([...BROADCASTER_PRESETS, ...fromTeams])].sort()
  }, [teams])

  async function saveTeamField(team, field, raw) {
    const prev = team[field]
    let value = raw
    if (['impression_rank', 'yougov_popularity', 'base_score'].includes(field)) {
      value = raw === '' ? null : parseInt(raw, 10)
      if (Number.isNaN(value)) return
    } else if (field === 'impression_estimate') {
      value = raw === '' ? null : parseFloat(raw)
      if (Number.isNaN(value)) return
    } else if (field === 'is_augmentation_team') {
      value = !!raw
    } else if (field === 'broadcaster') {
      value = raw.trim() || null
    }
    if (value === prev) return
    try {
      await db.updateTeam(team.id ?? team.full_name, { [field]: value })
      const label = field === 'is_augmentation_team'
        ? (value ? 'enabled augmentation partnership' : 'removed from augmentation program')
        : `${field.replace(/_/g, ' ')} ${prev ?? '—'} → ${value ?? '—'}`
      await afterModelChange('Team Data', `Updated ${team.short_name || team.full_name}: ${label}`)
    } catch (e) {
      flash('Save failed: ' + e.message)
    }
  }

  async function activatePartnership(e) {
    e.preventDefault()
    const team = teams.find((t) => String(t.id ?? t.full_name) === activateTeamId)
    if (!team) return
    const patch = {
      is_augmentation_team: true,
      broadcaster: activateBroadcaster.trim() || null,
    }
    if (activateImpressions.trim()) {
      const impr = parseFloat(activateImpressions)
      if (!Number.isNaN(impr)) patch.impression_estimate = impr
    }
    try {
      await db.updateTeam(team.id ?? team.full_name, patch)
      setActivateTeamId('')
      setActivateImpressions('')
      await afterModelChange(
        'Team Data',
        `Enabled augmentation for ${team.full_name} on ${patch.broadcaster || '—'}`
      )
    } catch (err) {
      flash('Save failed: ' + err.message)
    }
  }

  async function saveTierField(tierRow, field, raw) {
    const prev = tierRow[field]
    const value = field === 'cpm' ? parseFloat(raw) : parseInt(raw, 10)
    if (Number.isNaN(value) || value === prev) return
    try {
      await db.updateTier(tierRow.tier, { [field]: value })
      const next = tiers.map((t) => (t.tier === tierRow.tier ? { ...t, [field]: value } : t))
      setTiers(next)
      await afterModelChange(
        'Matchup Valuation',
        `Updated ${tierRow.tier}: ${field} ${prev} → ${value}`
      )
    } catch (e) {
      flash('Save failed: ' + e.message)
    }
  }

  async function saveLogoPlacements(raw) {
    const value = parseInt(raw, 10)
    const prev = settings.logo_placements_per_game
    if (Number.isNaN(value) || value === prev) return
    try {
      await db.updateSetting('logo_placements_per_game', value)
      setSettings((s) => ({ ...s, logo_placements_per_game: value }))
      await afterModelChange(
        'Game Package Curation',
        `Updated logo placements per game: ${prev ?? '—'} → ${value}`
      )
    } catch (e) {
      flash('Save failed: ' + e.message)
    }
  }

  async function saveGameField(game, patch, label) {
    if (projection2027) {
      setGameField(game.id, patch)
      appendLog({ tabs: 'Full NBA Schedule', description: `${label} (2027 preview — local only)` })
      flash('Saved locally for 2027 preview')
      return
    }
    const parts = Object.entries(patch).map(([k, v]) => `${k}: ${game[k] ?? '—'} → ${v ?? '—'}`)
    await setGameField(game.id, patch)
    appendLog({
      tabs: 'Full NBA Schedule',
      description: `${shortTeam(game.away_team)} @ ${shortTeam(game.home_team)} (${game.game_date}) — ${parts.join('; ')}`,
    })
    await onRefresh()
    flash('Schedule updated')
  }

  function addNote(e) {
    e.preventDefault()
    if (!noteText.trim()) return
    appendLog({ tabs: noteTab, description: noteText.trim() })
    setNoteText('')
    flash('Note added to change log')
  }

  return (
    <div className="manual-updates">
      <div className="manual-intro card" style={{ padding: '14px 16px', marginBottom: 14 }}>
        <p>
          Same control as the Excel workbook — blue cells here are editable. Changes save to the database and
          automatically refresh tier scores, CPMs, and package totals.
        </p>
        {projection2027 && (
          <p className="warn">
            2027 preview mode: schedule status/contact edits are local-only; team and tier changes still update the model.
          </p>
        )}
      </div>

      <div className="subtabs">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={section === s.id ? 'active' : ''}
            onClick={() => setSection(s.id)}
          >
            {s.label}
            <span className="excel-ref">{s.excel}</span>
          </button>
        ))}
      </div>

      {section === 'schedule' && (
        <div className="card">
          <div className="section-toolbar">
            <div className="field" style={{ flex: 1, minWidth: 200 }}>
              <label>Search games</label>
              <input
                placeholder="Team, brand, status, date…"
                value={scheduleQ}
                onChange={(e) => setScheduleQ(e.target.value)}
              />
            </div>
            <span className="count">{scheduleRows.length} games</span>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Matchup</th>
                  <th>Status</th>
                  <th>Brand / contact</th>
                  <th>Home RSN</th>
                  <th>Away RSN</th>
                  <th>National</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {scheduleRows.map((g) => (
                  <tr key={g.id}>
                    <td className="muted">{g.game_date}</td>
                    <td className="matchup">
                      {shortTeam(g.away_team)} <span className="muted">@</span> {shortTeam(g.home_team)}
                    </td>
                    <td>
                      <select
                        className={`status editable ${g.status}`}
                        value={g.status}
                        onChange={(e) => saveGameField(g, { status: e.target.value }, 'status')}
                      >
                        {STATUSES.map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        className="editable"
                        defaultValue={g.brand_contact || ''}
                        placeholder="—"
                        onBlur={(e) => {
                          const v = e.target.value.trim() || null
                          if (v !== (g.brand_contact || null)) saveGameField(g, { brand_contact: v }, 'brand')
                        }}
                      />
                    </td>
                    <td>
                      <input
                        className="editable narrow"
                        defaultValue={g.home_rsn || ''}
                        placeholder="—"
                        onBlur={(e) => {
                          const v = e.target.value.trim() || null
                          if (v !== (g.home_rsn || null)) saveGameField(g, { home_rsn: v }, 'home RSN')
                        }}
                      />
                    </td>
                    <td>
                      <input
                        className="editable narrow"
                        defaultValue={g.away_rsn || ''}
                        placeholder="—"
                        onBlur={(e) => {
                          const v = e.target.value.trim() || null
                          if (v !== (g.away_rsn || null)) saveGameField(g, { away_rsn: v }, 'away RSN')
                        }}
                      />
                    </td>
                    <td>
                      <label className="check-label">
                        <input
                          type="checkbox"
                          checked={!!g.national_exclusive}
                          onChange={(e) =>
                            saveGameField(g, { national_exclusive: e.target.checked }, 'national exclusive')
                          }
                        />
                        Flex
                      </label>
                    </td>
                    <td>
                      <input
                        className="editable wide"
                        defaultValue={g.notes || ''}
                        placeholder="—"
                        onBlur={(e) => {
                          const v = e.target.value.trim() || null
                          if (v !== (g.notes || null)) saveGameField(g, { notes: v }, 'notes')
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {section === 'teams' && (
        <div className="layout teams-layout">
          <div className="card">
            <div className="section-toolbar">
              <h4>Active partnerships</h4>
              <span className="count">{augTeams.length} teams</span>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Team</th>
                    <th>Broadcaster</th>
                    <th className="num">Impr. rank</th>
                    <th className="num">YouGov pop.</th>
                    <th className="num">Impressions</th>
                    <th className="num">Base score</th>
                    <th>Active</th>
                  </tr>
                </thead>
                <tbody>
                  {augTeams.map((t) => (
                    <tr key={t.full_name}>
                      <td className="matchup">{t.full_name}</td>
                      <td>
                        <BroadcasterInput
                          value={t.broadcaster}
                          options={broadcasterOptions}
                          onSave={(v) => saveTeamField(t, 'broadcaster', v)}
                        />
                      </td>
                      <td className="num">
                        <NumInput value={t.impression_rank} onSave={(v) => saveTeamField(t, 'impression_rank', v)} />
                      </td>
                      <td className="num">
                        <NumInput value={t.yougov_popularity} onSave={(v) => saveTeamField(t, 'yougov_popularity', v)} />
                      </td>
                      <td className="num">
                        <NumInput
                          value={t.impression_estimate}
                          step="0.1"
                          onSave={(v) => saveTeamField(t, 'impression_estimate', v)}
                        />
                      </td>
                      <td className="num">
                        <NumInput value={t.base_score} onSave={(v) => saveTeamField(t, 'base_score', v)} />
                      </td>
                      <td>
                        <label className="check-label">
                          <input
                            type="checkbox"
                            checked
                            onChange={() => saveTeamField(t, 'is_augmentation_team', false)}
                          />
                          On
                        </label>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="summary partnership-panel">
            <h3>Add partnership</h3>
            <form onSubmit={activatePartnership}>
              <p className="hint">
                Turn on augmentation for an NBA team when a new RSN deal is secured.
              </p>
              <div className="field">
                <label>Team</label>
                <select
                  value={activateTeamId}
                  onChange={(e) => setActivateTeamId(e.target.value)}
                  required
                >
                  <option value="">Select team…</option>
                  {inactiveTeams.map((t) => (
                    <option key={t.full_name} value={t.id ?? t.full_name}>
                      {t.full_name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Broadcaster / RSN deal</label>
                <BroadcasterInput
                  value={activateBroadcaster}
                  options={broadcasterOptions}
                  controlled
                  onChange={setActivateBroadcaster}
                />
              </div>
              <div className="field">
                <label>Impression estimate (optional)</label>
                <input
                  type="number"
                  step="0.1"
                  placeholder="Per-game reach"
                  value={activateImpressions}
                  onChange={(e) => setActivateImpressions(e.target.value)}
                />
              </div>
              <button type="submit" className="btn" disabled={!activateTeamId}>
                Enable partnership
              </button>
              {inactiveTeams.length === 0 && (
                <p className="hint">All NBA teams are already active.</p>
              )}
            </form>

            <div className="broadcaster-list">
              <h4>Known broadcasters</h4>
              <ul>
                {broadcasterOptions.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
              <p className="hint">Type a new name in any broadcaster field to add it when you save.</p>
            </div>
          </div>
        </div>
      )}

      {section === 'tiers' && (
        <div className="layout tiers-layout">
          <div className="card">
            <div className="section-toolbar">
              <h4>Tier structure &amp; CPM</h4>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Tier</th>
                  <th className="num">Score min</th>
                  <th className="num">Score max</th>
                  <th className="num">CPM</th>
                </tr>
              </thead>
              <tbody>
                {tiers.map((t) => (
                  <tr key={t.tier}>
                    <td><span className={`tier ${String(t.tier).replace(' ', '')}`}>{t.tier}</span></td>
                    <td className="num">
                      <NumInput value={t.score_lo} onSave={(v) => saveTierField(t, 'score_lo', v)} />
                    </td>
                    <td className="num">
                      <NumInput value={t.score_hi} onSave={(v) => saveTierField(t, 'score_hi', v)} />
                    </td>
                    <td className="num">
                      <NumInput value={t.cpm} step="0.01" onSave={(v) => saveTierField(t, 'cpm', v)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="summary">
            <h3>Package settings</h3>
            <div className="field">
              <label>Logo placements per game</label>
              <input
                className="editable"
                type="number"
                min={1}
                defaultValue={settings.logo_placements_per_game ?? 10}
                onBlur={(e) => saveLogoPlacements(e.target.value)}
              />
            </div>
            <p className="hint">
              From Game Package Curation — affects impression estimates and blended CPM across all packages.
            </p>
          </div>
        </div>
      )}

      {section === 'log' && (
        <div className="layout log-layout">
          <div className="card">
            <div className="section-toolbar">
              <h4>Model changes</h4>
              <span className="count">{log.length} entries</span>
            </div>
            <div className="table-scroll log-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Author</th>
                    <th>Tab</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {log.map((row) => (
                    <tr key={row.id}>
                      <td className="muted">{row.date}</td>
                      <td>{row.author}</td>
                      <td className="muted">{row.tabs}</td>
                      <td>{row.description}</td>
                    </tr>
                  ))}
                  {log.length === 0 && (
                    <tr>
                      <td colSpan={4} className="loading">
                        No changes logged yet — edits from other sections appear here automatically.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <div className="summary">
            <h3>Add a note</h3>
            <form onSubmit={addNote}>
              <div className="field">
                <label>Tab</label>
                <select value={noteTab} onChange={(e) => setNoteTab(e.target.value)}>
                  {SECTIONS.filter((s) => s.id !== 'log').map((s) => (
                    <option key={s.excel} value={s.excel}>{s.excel}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Description</label>
                <textarea
                  rows={4}
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="e.g. Updated FDSN schedule for Spurs & Grizzlies"
                />
              </div>
              <button type="submit" className="btn" disabled={!noteText.trim()}>
                Add to log
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

function NumInput({ value, onSave, step = '1' }) {
  return (
    <input
      className="editable num-input"
      type="number"
      step={step}
      defaultValue={value ?? ''}
      onBlur={(e) => onSave(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.target.blur()
      }}
    />
  )
}

function BroadcasterInput({ value, options, onSave, controlled, onChange }) {
  const listId = useId()
  if (controlled) {
    return (
      <>
        <input
          className="editable"
          list={listId}
          value={value ?? ''}
          placeholder="Broadcaster name"
          onChange={(e) => onChange(e.target.value)}
        />
        <datalist id={listId}>
          {options.map((b) => (
            <option key={b} value={b} />
          ))}
        </datalist>
      </>
    )
  }
  return (
    <>
      <input
        className="editable"
        list={listId}
        defaultValue={value ?? ''}
        placeholder="—"
        onBlur={(e) => onSave(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.target.blur()
        }}
      />
      <datalist id={listId}>
        {options.map((b) => (
          <option key={b} value={b} />
        ))}
      </datalist>
    </>
  )
}
