import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDashboard } from '../context/DashboardContext'
import NavBar from "../components/NavBar";
import { fetchSubscriptions, fetchDriftEvents } from '../services/api'
import './DashboardHome.css'

const FILTER_OPTIONS = {
  time: { label: 'Time', icon: 'schedule', options: ['Last 1 Hour', 'Last 24 Hours', 'Last 7 Days'] },
  subscription: { label: 'Subscription', icon: 'layers', options: ['Azure Sub – Dev', 'Azure Sub – Staging', 'Azure Sub – Production'] },
  resourceGroup: { label: 'Resource Group', icon: 'folder', options: ['rg-webapp-prod', 'rg-database-dev', 'rg-network-core'] },
  resource: { label: 'Resource', icon: 'dns', options: ['vm-web-01', 'sql-server-main', 'vnet-hub-central'] },
  username: { label: 'Username', icon: 'person', options: ['admin@contoso.com', 'devops@contoso.com', 'sre-team@contoso.com'] },
  change: { label: 'Change', icon: 'compare_arrows', options: ['Property Modified', 'Resource Deleted', 'Tag Changed'] },
}

function FilterDropdown({ filterKey, config, selected, onToggle, isOpen, onOpenToggle }) {
  const ref = useRef(null)

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) onOpenToggle(null)
    }
    if (isOpen) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isOpen, onOpenToggle])

  const count = selected.length

  return (
    <div className="dh-filter-dropdown" ref={ref}>
      <button
        className={`dh-filter-btn ${isOpen ? 'dh-filter-btn--open' : ''} ${count > 0 ? 'dh-filter-btn--active' : ''}`}
        onClick={() => onOpenToggle(isOpen ? null : filterKey)}
      >
        <span className="material-symbols-outlined dh-filter-btn-icon">{config.icon}</span>
        {config.label}
        {count > 0 && <span className="dh-filter-count">{count}</span>}
        <span className="material-symbols-outlined dh-filter-chevron">{isOpen ? 'expand_less' : 'expand_more'}</span>
      </button>
      {isOpen && (
        <div className="dh-filter-menu">
          {config.options.map(opt => (
            <label key={opt} className="dh-filter-option">
              <input
                type="checkbox"
                checked={selected.includes(opt)}
                onChange={() => onToggle(filterKey, opt)}
                className="dh-filter-checkbox"
              />
              <span className="dh-filter-option-text">{opt}</span>
            </label>
          ))}
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

function KpiCard({ label, value, icon, trend, trendUp }) {
  return (
    <div className="kpi-card">
      <div className="kpi-card-header">
        <span className="kpi-label">{label}</span>
        <span className="kpi-icon material-symbols-outlined">{icon}</span>
      </div>
      <div className="kpi-value-row">
        <span className="kpi-value">{value ?? '—'}</span>
        {trend && (
          <span className={`kpi-trend ${trendUp ? 'kpi-trend--up' : 'kpi-trend--down'}`}>
            <span className="material-symbols-outlined">{trendUp ? 'trending_up' : 'trending_down'}</span>
            {trend}
          </span>
        )}
      </div>
    </div>
  )
}

function DonutChart({ drifted, total }) {
  const pct = total > 0 ? Math.round((drifted / total) * 100) : 0
  const dash = (pct / 100) * 100
  return (
    <div className="donut-wrap">
      <h3 className="donut-title">Percentage of Drift</h3>
      <div className="donut-chart">
        <svg viewBox="0 0 36 36" className="donut-svg">
          <path className="donut-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#e2e8f0" strokeWidth="3" />
          <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#f59e0b" strokeWidth="3.5" strokeLinecap="round" strokeDasharray={`${dash}, 100`} />
        </svg>
        <div className="donut-center">
          <span className="donut-number">{drifted}</span>
          <span className="donut-sub">Drifted</span>
        </div>
      </div>
      <div className="donut-legend">
        <div className="donut-legend-item"><span className="donut-dot" style={{ background: '#f59e0b' }} />Drifted</div>
        <div className="donut-legend-item"><span className="donut-dot" style={{ background: '#e2e8f0' }} />Compliant</div>
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
          <p className="bar-chart-sub">Drift volume over time</p>
        </div>
      </div>
      <div className="bar-chart-bars">
        {data.map((d, i) => (
          <div key={i} className="bar-col">
            <div className="bar-outer">
              <div className="bar-inner" style={{ height: `${(d.count / max) * 100}%`, background: d.count > 50 ? '#ef4444' : d.count > 20 ? '#1995ff' : '#c2c7d0' }} title={`${d.count} changes`} />
            </div>
            <span className="bar-label">{d.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function DashboardHome() {
  const navigate = useNavigate()
  const { subscription, resourceGroup, resource, configData } = useDashboard()

  const [subs,        setSubs]        = useState([])
  const [driftEvents, setDriftEvents] = useState([])
  const [loading,     setLoading]     = useState(true)
  const [search,      setSearch]      = useState('')

  // Filter state
  const emptyFilters = { time: [], subscription: [], resourceGroup: [], resource: [], username: [], change: [] }
  const [pendingFilters, setPendingFilters] = useState({ ...emptyFilters })
  const [appliedFilters, setAppliedFilters] = useState({ ...emptyFilters })
  const [openFilter,     setOpenFilter]     = useState(null)

  const toggleFilterOption = (key, option) => {
    setPendingFilters(prev => {
      const arr = prev[key]
      return { ...prev, [key]: arr.includes(option) ? arr.filter(o => o !== option) : [...arr, option] }
    })
  }

  const applyFilters = () => {
    setAppliedFilters({ ...pendingFilters })
    setOpenFilter(null)
  }

  const clearFilters = () => {
    setPendingFilters({ ...emptyFilters })
    setAppliedFilters({ ...emptyFilters })
    setOpenFilter(null)
  }

  const hasActiveFilters = Object.values(appliedFilters).some(arr => arr.length > 0)
  const hasPendingChanges = JSON.stringify(pendingFilters) !== JSON.stringify(appliedFilters)

  const user = (() => { try { return JSON.parse(sessionStorage.getItem('user') || '{}') } catch { return {} } })()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const s = await fetchSubscriptions()
      setSubs(Array.isArray(s) ? s : [])
    } catch { setSubs([]) }

    if (subscription) {
      try {
        const events = await fetchDriftEvents(subscription, { limit: 20 })
        setDriftEvents(Array.isArray(events) ? events : [])
      } catch { setDriftEvents([]) }
    }
    setLoading(false)
  }, [subscription])

  useEffect(() => { load() }, [load])

  // Build 24h bar chart data from drift events
  const barData = (() => {
    const hours = Array.from({ length: 6 }, (_, i) => {
      const h = i * 4
      return { label: `${String(h).padStart(2, '0')}:00`, count: 0 }
    })
    driftEvents.forEach(ev => {
      const h = new Date(ev.detectedAt).getHours()
      const bucket = Math.floor(h / 4)
      if (hours[bucket]) hours[bucket].count++
    })
    return hours
  })()

  const totalDrift    = driftEvents.length
  const criticalCount = driftEvents.filter(e => e.severity === 'critical').length
  const filtered      = search
    ? driftEvents.filter(e => e.resourceId?.toLowerCase().includes(search.toLowerCase()) || e.resourceGroup?.toLowerCase().includes(search.toLowerCase()))
    : driftEvents

  const navigateToDriftScanner = () => navigate('/dashboard')
  const navigateToComparison   = (ev) => navigate('/comparison', {
    state: { subscriptionId: ev.subscriptionId, resourceGroupId: ev.resourceGroup, resourceId: ev.resourceId, resourceName: ev.resourceId?.split('/').pop(), liveState: ev.liveState }
  })

  return (
    <div className="dh-root">
      <NavBar
        user={user}
        subscription={subscription}
        resourceGroup={resourceGroup}
        resource={resource}
        configData={configData}
      />

      <main className="dh-main">
        {/* Header */}
        {/* <header className="dh-header">
          <h1 className="dh-headline">Welcome, {user.name || 'Administrator'}</h1>
          <p className="dh-subline">Monitoring environment integrity through real-time drift analysis.</p>
        </header> */}

        {/* KPI Cards */}
        <div className="dh-kpi-grid">
          <KpiCard label="Subscriptions"    value={subs.length}                                icon="layers"      trend={null} />
          <KpiCard label="Resource Groups"     value={resourceGroup.length}                                 icon="history"     trend={null} />
          <KpiCard label="Resources"  value={resource.length}                              icon="warning"     trend={null} trendUp={false} />
          <KpiCard label="Total Changes"        value={subscription ? 'Active' : 'None'}           icon="monitor_heart" trend={null} trendUp={true} />
        </div>

        {/* Charts Row */}
        <div className="dh-charts-row">
          <DonutChart drifted={totalDrift} total={Math.max(totalDrift + 10, 20)} />
          <BarChart data={barData} />
        </div>

        {/* Recent Changes Table */}
        <div className="dh-table-section">
          <div className="dh-table-header">
            <div className="dh-table-title-row">
              <h2 className="dh-table-title">Recent Drift Events</h2>
              {totalDrift > 0 && (
                <span className="dh-live-badge">
                  <span className="dh-live-dot" />
                  {totalDrift} events
                </span>
              )}
            </div>
            {/* <button className="dh-view-all" onClick={navigateToDriftScanner}>
              Open Drift Scanner <span className="material-symbols-outlined">arrow_forward</span>
            </button> */}
          </div>

          {/* Filter Bar */}
          <div className="dh-filter-bar">
            <div className="dh-filter-bar-left">
              <span className="material-symbols-outlined dh-filter-bar-icon">filter_list</span>
              {Object.entries(FILTER_OPTIONS).map(([key, config]) => (
                <FilterDropdown
                  key={key}
                  filterKey={key}
                  config={config}
                  selected={pendingFilters[key]}
                  onToggle={toggleFilterOption}
                  isOpen={openFilter === key}
                  onOpenToggle={setOpenFilter}
                />
              ))}
            </div>
            <div className="dh-filter-bar-right">
              {hasActiveFilters && (
                <button className="dh-filter-clear" onClick={clearFilters}>
                  <span className="material-symbols-outlined">close</span>
                  Clear All
                </button>
              )}
              <button
                className={`dh-filter-apply ${hasPendingChanges ? 'dh-filter-apply--active' : ''}`}
                onClick={applyFilters}
                disabled={!hasPendingChanges}
              >
                <span className="material-symbols-outlined">check</span>
                Apply
              </button>
            </div>
          </div>

          <div className="dh-table-wrap">
            {loading ? (
              <div className="dh-empty">Loading drift events...</div>
            ) : filtered.length === 0 ? (
              <div className="dh-empty">
                {subscription ? 'No drift events found.' : 'Select a subscription in the Drift Scanner to see events here.'}
                
              </div>
            ) : (
              <table className="dh-table">
                <thead>
                  <tr>
                    <th>Resource</th>
                    <th>Type</th>
                    <th>Resource Group</th>
                    <th>Detected</th>
                    <th>Severity</th>
                    <th>Changes</th>
                    <th className="dh-th-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(0, 10).map((ev, i) => {
                    const sev = SEVERITY_COLOR[ev.severity] || SEVERITY_COLOR.low
                    const resName = ev.resourceId?.split('/').pop() || '—'
                    const resType = ev.resourceId?.split('/')?.[7] || '—'
                    return (
                      <tr key={ev._blobKey || i} className="dh-tr">
                        <td className="dh-td-resource">{resName}</td>
                        <td className="dh-td-type">{resType}</td>
                        <td>{ev.resourceGroup || '—'}</td>
                        <td>{ev.detectedAt ? new Date(ev.detectedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
                        <td>
                          <div className="dh-severity" style={{ color: sev.text }}>
                            <span className="dh-severity-dot" style={{ background: sev.dot }} />
                            {sev.label}
                          </div>
                        </td>
                        <td>{ev.changeCount ?? 0}</td>
                        <td className="dh-td-action">
                          <button className="dh-action-btn" onClick={() => navigateToComparison(ev)} title="View comparison">
                            <span className="material-symbols-outlined">open_in_new</span>
                          </button>
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
