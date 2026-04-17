import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDashboard } from '../context/DashboardContext'
import NavBar from '../components/NavBar'
import { fetchSubscriptions, fetchResourceGroups, fetchResources, fetchDriftEvents, fetchStatsToday, fetchResourceConfiguration, fetchRecentChanges } from '../services/api'
import './DashboardHome.css'

// ── Filter dropdown component ─────────────────────────────────────────────────
function FilterDropdown({ filterKey, config, selected, onToggle, isOpen, onOpenToggle }) {
  const ref = useRef(null)
  useEffect(() => {
    function handleClick(e) { if (ref.current && !ref.current.contains(e.target)) onOpenToggle(null) }
    if (isOpen) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isOpen, onOpenToggle])

  return (
    <div className="dh-filter-dropdown" ref={ref}>
      <button className={`dh-filter-btn ${isOpen ? 'dh-filter-btn--open' : ''} ${selected.length > 0 ? 'dh-filter-btn--active' : ''}`}
        onClick={() => onOpenToggle(isOpen ? null : filterKey)}>
        <span className="material-symbols-outlined dh-filter-btn-icon">{config.icon}</span>
        {config.label}
        {selected.length > 0 && <span className="dh-filter-count">{selected.length}</span>}
        <span className="material-symbols-outlined dh-filter-chevron">{isOpen ? 'expand_less' : 'expand_more'}</span>
      </button>
      {isOpen && (
        <div className="dh-filter-menu">
          {config.options.length === 0
            ? <div style={{ padding: '12px 16px', fontSize: 12, color: '#94a3b8' }}>No options available</div>
            : config.options.map(opt => (
              <label key={opt} className="dh-filter-option">
                <input type="checkbox" checked={selected.includes(opt)} onChange={() => onToggle(filterKey, opt)} className="dh-filter-checkbox" />
                <span className="dh-filter-option-text">{opt}</span>
              </label>
            ))
          }
        </div>
      )}
    </div>
  )
}

const SEVERITY_COLOR = {
  critical: { dot: '#ef4444', text: '#ef4444', label: 'Critical' },
  high:     { dot: '#f97316', text: '#f97316', label: 'High' },
  medium:   { dot: '#f59e0b', text: '#f59e0b', label: 'Medium' },
  low:      { dot: '#10b981', text: '#10b981', label: 'Low' },
}

function KpiCard({ label, value, icon }) {
  return (
    <div className="kpi-card">
      <div className="kpi-card-header">
        <span className="kpi-label">{label}</span>
        <span className="kpi-icon material-symbols-outlined">{icon}</span>
      </div>
      <div className="kpi-value-row">
        <span className="kpi-value">{value ?? '—'}</span>
      </div>
    </div>
  )
}

function DonutChart({ drifted, total }) {
  const pct  = total > 0 ? Math.round((drifted / total) * 100) : 0
  const dash = Math.min((pct / 100) * 100, 100)
  return (
    <div className="donut-wrap">
      <h3 className="donut-title">Percentage of Drift (Today)</h3>
      <div className="donut-chart">
        <svg viewBox="0 0 36 36" className="donut-svg">
          <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#e2e8f0" strokeWidth="3" />
          <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#f59e0b" strokeWidth="3.5" strokeLinecap="round" strokeDasharray={`${dash}, 100`} />
        </svg>
        <div className="donut-center">
          <span className="donut-number">{drifted}</span>
          <span className="donut-sub">Drifted</span>
        </div>
      </div>
      <div className="donut-legend">
        <div className="donut-legend-item"><span className="donut-dot" style={{ background: '#f59e0b' }} />Drifted ({drifted})</div>
        <div className="donut-legend-item"><span className="donut-dot" style={{ background: '#e2e8f0' }} />Compliant ({Math.max(total - drifted, 0)})</div>
      </div>
    </div>
  )
}

function BarChart({ data }) {
  const max = Math.max(...data.map(d => d.count), 1)
  return (
    <div className="bar-chart-wrap">
      <div className="bar-chart-header">
        <div>
          <h3 className="bar-chart-title">24-Hour Change Statistics</h3>
          <p className="bar-chart-sub">Hourly drift volume — today 00:00 to now</p>
        </div>
      </div>
      <div className="bar-chart-bars">
        {data.map((d, i) => (
          <div key={i} className="bar-col">
            <div className="bar-outer">
              <div className="bar-inner" style={{
                height: `${(d.count / max) * 100}%`,
                background: d.count > 10 ? '#ef4444' : d.count > 3 ? '#1995ff' : '#c2c7d0'
              }} title={`${d.label}: ${d.count} changes`} />
            </div>
            {i % 4 === 0 && <span className="bar-label">{d.label}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

export default function DashboardHome() {
  const navigate = useNavigate()
  const { subscription: ctxSub, resourceGroup, resource, configData } = useDashboard()

  const [subs,        setSubs]        = useState([])
  const [rgs,         setRgs]         = useState([])
  const [totalRes,    setTotalRes]    = useState(0)
  const [activeSub,   setActiveSub]   = useState(ctxSub || '')
  const [stats,       setStats]       = useState(null)
  const [driftEvents, setDriftEvents] = useState([])
  const [loading,     setLoading]     = useState(true)
  const [search,      setSearch]      = useState('')

  const user = (() => { try { return JSON.parse(sessionStorage.getItem('user') || '{}') } catch { return {} } })()

  // Today midnight ISO
  const todayMidnight = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.toISOString() })()

  // Filter state
  const emptyFilters = { time: ['Last 24 Hours'], subscription: [], resourceGroup: [], resource: [], username: [], change: [] }
  const [pendingFilters, setPendingFilters] = useState({ ...emptyFilters })
  const [appliedFilters, setAppliedFilters] = useState({ ...emptyFilters })
  const [openFilter,     setOpenFilter]     = useState(null)

  const toggleFilterOption = (key, option) => {
    setPendingFilters(prev => {
      const arr = prev[key]
      // Time is single-select
      if (key === 'time') return { ...prev, time: [option] }
      return { ...prev, [key]: arr.includes(option) ? arr.filter(o => o !== option) : [...arr, option] }
    })
  }

  const applyFilters = () => { setAppliedFilters({ ...pendingFilters }); setOpenFilter(null) }
  const clearFilters = () => { setPendingFilters({ ...emptyFilters }); setAppliedFilters({ ...emptyFilters }); setOpenFilter(null) }
  const hasActiveFilters = Object.entries(appliedFilters).some(([k, arr]) => k !== 'time' && arr.length > 0)
  const hasPendingChanges = JSON.stringify(pendingFilters) !== JSON.stringify(appliedFilters)

  // Compute `since` from time filter
  const getSince = () => {
    const t = appliedFilters.time[0] || 'Last 24 Hours'
    if (t === 'Last 1 Hour')  return new Date(Date.now() - 3600000).toISOString()
    if (t === 'Last 7 Days')  return new Date(Date.now() - 7 * 86400000).toISOString()
    return todayMidnight // Last 24 Hours default
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const s = await fetchSubscriptions()
      const subList = Array.isArray(s) ? s : []
      setSubs(subList)
      const sub = activeSub || subList[0]?.id || ''
      if (!activeSub && sub) setActiveSub(sub)
      if (!sub) { setLoading(false); return }

      const rgList = await fetchResourceGroups(sub).catch(() => [])
      const rgArr = Array.isArray(rgList) ? rgList : []
      setRgs(rgArr)
      let resCount = 0
      await Promise.allSettled(rgArr.slice(0, 10).map(async rg => {
        const resList = await fetchResources(sub, rg.id || rg.name).catch(() => [])
        resCount += Array.isArray(resList) ? resList.length : 0
      }))
      setTotalRes(resCount)

      const statsData = await fetchStatsToday(sub).catch(() => null)
      setStats(statsData)

      // Fetch from all-changes blob — last 24h by default, respects time filter
      const timeLabel = appliedFilters.time[0] || 'Last 24 Hours'
      const hours = timeLabel === 'Last 1 Hour' ? 1 : timeLabel === 'Last 7 Days' ? 168 : 24
      const rgFilter     = appliedFilters.resourceGroup[0] || undefined
      const callerFilter = appliedFilters.username[0]      || undefined
      const typeFilter   = appliedFilters.change[0] === 'Resource Deleted' ? 'deleted'
                         : appliedFilters.change[0] === 'Property Modified' || appliedFilters.change[0] === 'Tag Changed' ? 'modified'
                         : undefined
      const events = await fetchRecentChanges(sub, { resourceGroup: rgFilter, caller: callerFilter, changeType: typeFilter, hours, limit: 200 }).catch(() => [])
      setDriftEvents(Array.isArray(events) ? events : [])
    } catch (e) {
      console.error('[DashboardHome] load error:', e.message)
    } finally {
      setLoading(false)
    }
  }, [activeSub, appliedFilters])

  useEffect(() => { load() }, [load])

  // Auto-refresh counts every 30 seconds
  useEffect(() => {
    const id = setInterval(() => load(), 30000)
    return () => clearInterval(id)
  }, [load])

  // Dynamic filter options — derived from loaded all-changes data
  const filterOptions = {
    time:          { label: 'Time',           icon: 'schedule',        options: ['Last 1 Hour', 'Last 24 Hours', 'Last 7 Days'] },
    subscription:  { label: 'Subscription',   icon: 'layers',          options: subs.map(s => s.name || s.id) },
    resourceGroup: { label: 'Resource Group', icon: 'folder',          options: rgs.map(r => r.name || r.id) },
    resource:      { label: 'Resource',       icon: 'dns',             options: [...new Set(driftEvents.map(e => e.resourceId?.split('/').pop()).filter(Boolean))] },
    username:      { label: 'Username',       icon: 'person',          options: [...new Set(driftEvents.map(e => e.caller).filter(Boolean))] },
    change:        { label: 'Change',         icon: 'compare_arrows',  options: ['Property Modified', 'Resource Deleted', 'Tag Changed'] },
  }

  // Client-side filtering (resource and tag-changed filters applied here since API doesn't support them)
  const applyClientFilters = (events) => {
    let result = events
    if (search) result = result.filter(e =>
      e.resourceId?.toLowerCase().includes(search.toLowerCase()) ||
      e.resourceGroup?.toLowerCase().includes(search.toLowerCase()) ||
      e.caller?.toLowerCase().includes(search.toLowerCase())
    )
    if (appliedFilters.resource.length)
      result = result.filter(e => appliedFilters.resource.includes(e.resourceId?.split('/').pop()))
    if (appliedFilters.change.includes('Tag Changed'))
      result = result.filter(e => (e.operationName || '').toLowerCase().includes('tag'))
    return result
  }

  const filtered = applyClientFilters(driftEvents)

  // Navigate to comparison with fresh live state
  const navigateToComparison = async (ev) => {
    let liveState = ev.liveState
    if (ev.resourceId && ev.subscriptionId && ev.resourceGroup) {
      try {
        liveState = await fetchResourceConfiguration(ev.subscriptionId, ev.resourceGroup, ev.resourceId)
      } catch { /* use stored liveState as fallback */ }
    }
    navigate('/comparison', {
      state: { subscriptionId: ev.subscriptionId, resourceGroupId: ev.resourceGroup, resourceId: ev.resourceId, resourceName: ev.resourceId?.split('/').pop(), liveState }
    })
  }

  const totalChanges  = stats?.allTimeTotal  ?? stats?.totalChanges ?? driftEvents.length
  const totalDrifted  = stats?.totalDrifted  ?? new Set(driftEvents.map(e => e.resourceId)).size
  const totalRGs      = rgs.length
  const byHour        = stats?.byHour        ?? Array.from({ length: 24 }, (_, h) => ({ hour: h, label: `${String(h).padStart(2,'0')}:00`, count: 0 }))

  return (
    <div className="dh-root">
      <NavBar user={user} subscription={ctxSub} resourceGroup={resourceGroup} resource={resource} configData={configData} />

      <main className="dh-main">
        {/* KPI Cards */}
        <div className="dh-kpi-grid">
          <KpiCard label="Subscriptions"      value={subs.length}    icon="layers" />
          <KpiCard label="Resource Groups"    value={totalRGs}       icon="folder" />
          <KpiCard label="Total Resources"    value={totalRes}       icon="dns" />
          <KpiCard label="Total Changes (All Time)" value={totalChanges}  icon="history" />
        </div>

        {/* Charts */}
        <div className="dh-charts-row">
          <DonutChart drifted={totalDrifted} total={Math.max(totalDrifted + (stats ? Math.max(totalRGs * 2 - totalDrifted, 0) : 10), totalDrifted + 1)} />
          <BarChart data={byHour} />
        </div>

        {/* Table */}
        <div className="dh-table-section">
          <div className="dh-table-header">
            <div className="dh-table-title-row">
              <h2 className="dh-table-title">Recent Events</h2>
              {driftEvents.length > 0 && (
                <span className="dh-live-badge">
                  <span className="dh-live-dot" />
                  {driftEvents.length} events
                </span>
              )}
            </div>
          </div>

          {/* Filter Bar */}
          <div className="dh-filter-bar">
            <div className="dh-filter-bar-left">
              <span className="material-symbols-outlined dh-filter-bar-icon">filter_list</span>
              {Object.entries(filterOptions).map(([key, config]) => (
                <FilterDropdown key={key} filterKey={key} config={config}
                  selected={pendingFilters[key]} onToggle={toggleFilterOption}
                  isOpen={openFilter === key} onOpenToggle={setOpenFilter} />
              ))}
            </div>
            <div className="dh-filter-bar-right">
              {hasActiveFilters && (
                <button className="dh-filter-clear" onClick={clearFilters}>
                  <span className="material-symbols-outlined">close</span>Clear All
                </button>
              )}
              <button className={`dh-filter-apply ${hasPendingChanges ? 'dh-filter-apply--active' : ''}`}
                onClick={applyFilters} disabled={!hasPendingChanges}>
                <span className="material-symbols-outlined">check</span>Apply
              </button>
            </div>
          </div>

          <div className="dh-table-wrap">
            {loading ? (
              <div className="dh-empty">Loading changes...</div>
            ) : filtered.length === 0 ? (
              <div className="dh-empty">
                {activeSub ? 'No changes found for the selected period.' : 'No subscription available.'}
              </div>
            ) : (
              <table className="dh-table">
                <thead>
                  <tr>
                    <th>Time</th><th>User</th><th>Resource</th>
                    <th>Resource Group</th><th>Operation</th><th>Type</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, 100).map((ev, i) => {
                    const resName = ev.resourceId?.split('/').pop() || '—'
                    const op = (ev.operationName || ev.eventType || '').split('/').slice(-2).join('/')
                    const isDelete = ev.changeType === 'deleted'
                    return (
                      <tr key={ev._blobKey || i} className="dh-tr">
                        <td style={{ whiteSpace: 'nowrap', color: '#94a3b8', fontSize: 12 }}>
                          {ev.detectedAt ? new Date(ev.detectedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                        </td>
                        <td style={{ color: '#60a5fa', fontWeight: 500 }}>{ev.caller || '—'}</td>
                        <td className="dh-td-resource" title={ev.resourceId}>{resName}</td>
                        <td>{ev.resourceGroup || '—'}</td>
                        <td style={{ fontSize: 12, color: '#94a3b8', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={ev.operationName}>{op || '—'}</td>
                        <td>
                          <span style={{
                            display: 'inline-block', padding: '2px 8px', borderRadius: 10,
                            fontSize: 11, fontWeight: 600,
                            background: isDelete ? 'rgba(239,68,68,0.15)' : 'rgba(99,179,237,0.15)',
                            color: isDelete ? '#ef4444' : '#63b3ed',
                          }}>{ev.changeType || 'modified'}</span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
