// FILE: src/pages/DashboardHome.jsx
// ROLE: Main dashboard page — KPI cards, charts, and recent ARM change events table

// What this page does:
//   - load(): fetches subscriptions, resource groups, resources, stats, and recent
//     changes on mount and every 30 seconds (keeps KPIs fresh without page reload)
//   - KpiCard: shows Subscriptions, Resource Groups, Total Resources, Total Changes
//   - DonutChart: shows unique resources changed today vs total resources
//     (data from GET /api/stats/today → changesIndex Table)
//   - BarChart: shows change volume over time with 24h / 7d / 30d toggle
//     (data from GET /api/stats/chart → changesIndex Table, self-fetching component)
//   - Recent Events table: shows last 100 ARM events from 'all-changes' blob
//     via GET /api/changes/recent. Clicking a non-deleted row navigates to
//     ComparisonPage with the resource pre-loaded (navigateToComparison)
//   - FilterDropdown: two-stage filter (pendingFilters → appliedFilters on Apply click)
//     so the table only re-fetches when the user explicitly applies filters

// NOTE: This page shows ALL ARM events (all-changes), not just severity-classified
//   drift (drift-records). This is intentional — it is an infrastructure audit log.

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDashboard } from '../context/DashboardContext'
import NavBar from '../components/NavBar'
import { fetchSubscriptions, fetchResourceGroups, fetchResources, fetchStatsToday, fetchResourceConfiguration, fetchRecentChanges, fetchChartStats } from '../services/api'
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

function DonutChart({ changed, total }) {
  const pct  = total > 0 ? Math.round((changed / total) * 100) : 0
  const dash = Math.min((pct / 100) * 100, 100)
  return (
    <div className="donut-wrap">
      <h3 className="donut-title">Resources Changed (Today)</h3>
      <div className="donut-chart">
        <svg viewBox="0 0 36 36" className="donut-svg">
          <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#e2e8f0" strokeWidth="3" />
          <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#f59e0b" strokeWidth="3.5" strokeLinecap="round" strokeDasharray={`${dash}, 1000`} />
        </svg>
        <div className="donut-center">
          <span className="donut-number">{changed}</span>
          <span className="donut-sub">{pct}%</span>
        </div>
      </div>
      <div className="donut-legend">
        <div className="donut-legend-item"><span className="donut-dot" style={{ background: '#f59e0b' }} />Changed ({changed})</div>
        <div className="donut-legend-item"><span className="donut-dot" style={{ background: '#e2e8f0' }} />Unchanged ({Math.max(total - changed, 0)})</div>
      </div>
    </div>
  )
}

function BarChart({ subscriptionId }) {
  const [mode, setMode] = useState('24h')
  const [data, setData] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!subscriptionId) return
    setLoading(true)
    fetchChartStats(subscriptionId, mode)
      .then(r => setData(r.buckets || []))
      .catch(() => setData([]))
      .finally(() => setLoading(false))
  }, [subscriptionId, mode])

  const max = Math.max(...data.map(d => d.count), 1)
  const titles = { '24h': '24-Hour Change Statistics', '7d': '7-Day Change Statistics', '30d': '30-Day Change Statistics' }
  const subs   = { '24h': 'Hourly — last 24 hours', '7d': 'Daily — last 7 days', '30d': 'Daily — last 30 days' }
  // Show every nth label to avoid crowding
  const labelEvery = mode === '24h' ? 1 : mode === '7d' ? 1 : 5

  return (
    <div className="bar-chart-wrap">
      <div className="bar-chart-header">
        <div>
          <h3 className="bar-chart-title">{titles[mode]}</h3>
          <p className="bar-chart-sub">{subs[mode]}</p>
        </div>
        <div className="bar-chart-modes">
          {['24h', '7d', '30d'].map(m => (
            <button key={m} className={`bar-mode-btn ${mode === m ? 'bar-mode-btn--active' : ''}`}
              onClick={() => setMode(m)}>{m}</button>
          ))}
        </div>
      </div>
      {loading ? (
        <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 13 }}>Loading...</div>
      ) : (
        <div className="bar-chart-bars">
          {data.map((d, i) => (
            <div key={i} className="bar-col">
              <div className="bar-outer">
                <div className="bar-inner" style={{
                  height: `${(d.count / max) * 100}%`,
                  background: d.count > 10 ? '#ef4444' : d.count > 3 ? '#1995ff' : '#c2c7d0'
                }} title={`${d.label}: ${d.count} change${d.count !== 1 ? 's' : ''}`} />
              </div>
              {i % labelEvery === 0 && <span className="bar-label" style={mode === '24h' ? { transform: 'rotate(-25deg)', transformOrigin: 'top left', fontSize: 9, whiteSpace: 'nowrap' } : {}}>{d.label}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function DashboardHome() {
  const navigate = useNavigate()
  const { subscription: ctxSub, resourceGroup, resource, configData } = useDashboard()

  // List of Azure subscriptions the user has access to (fetched from /api/subscriptions)
  const [subscriptionList,    setSubscriptionList]    = useState([])

  // List of resource groups in the active subscription (fetched from /api/resource-groups)
  const [resourceGroupList,   setResourceGroupList]   = useState([])

  // Total count of all resources across the first 10 resource groups
  const [totalResourceCount,  setTotalResourceCount]  = useState(0)

  // The currently selected subscription ID — drives all data fetches
  const [activeSubscriptionId, setActiveSubscriptionId] = useState(ctxSub || '')

  // Today's stats from /api/stats/today: { totalChanges, totalDrifted, allTimeTotal }
  const [todayStats,          setTodayStats]          = useState(null)

  // The list of recent ARM change events shown in the table (from /api/changes/recent)
  const [recentChangeEvents,  setRecentChangeEvents]  = useState([])

  // Whether the page is currently loading data (shows 'Loading...' in the table)
  const [isLoadingData,       setIsLoadingData]       = useState(true)

  // Text typed in the search box — used for client-side filtering of the table
  const [searchText,          setSearchText]          = useState('')

  const user = (() => { try { return JSON.parse(sessionStorage.getItem('user') || '{}') } catch { return {} } })()

  // ISO timestamp for today at midnight — used as the default 'since' value for data fetches
  const todayMidnightISO = (() => { const d = new Date(); d.setHours(0,0,0,0); return d.toISOString() })()

  // Default filter state — time defaults to Last 24 Hours, all others empty (no filter)
  const defaultFilters = { time: ['Last 24 Hours'], subscription: [], resourceGroup: [], resource: [], username: [], change: [] }

  // pendingFilters: what the user has checked in the dropdowns but NOT yet applied
  // These update on every checkbox click but do NOT trigger a data fetch
  const [pendingFilters, setPendingFilters] = useState({ ...defaultFilters })

  // appliedFilters: the filters that are actually active and driving the data fetch
  // Only updated when the user clicks the Apply button
  const [appliedFilters, setAppliedFilters] = useState({ ...defaultFilters })

  // Which filter dropdown is currently open (null = all closed)
  const [openFilterKey, setOpenFilterKey] = useState(null)

  // Called when the user checks/unchecks a filter option in a dropdown
  // Time filter is single-select (only one time range at a time)
  // All other filters are multi-select (can pick multiple resource groups, users, etc.)
  const toggleFilterOption = (filterCategory, selectedOption) => {
    setPendingFilters(previousFilters => {
      const currentSelections = previousFilters[filterCategory]
      if (filterCategory === 'time') return { ...previousFilters, time: [selectedOption] }
      const isAlreadySelected = currentSelections.includes(selectedOption)
      return {
        ...previousFilters,
        [filterCategory]: isAlreadySelected
          ? currentSelections.filter(opt => opt !== selectedOption)  // remove it
          : [...currentSelections, selectedOption]                   // add it
      }
    })
  }

  // Moves pendingFilters into appliedFilters — this triggers load() to re-fetch with new filters
  const applyFilters = () => { setAppliedFilters({ ...pendingFilters }); setOpenFilterKey(null) }

  // Resets all filters back to defaults and re-fetches
  const clearFilters = () => { setPendingFilters({ ...defaultFilters }); setAppliedFilters({ ...defaultFilters }); setOpenFilterKey(null) }

  // True if any non-time filter has a selection (used to show the Clear All button)
  const hasActiveFilters = Object.entries(appliedFilters).some(([filterKey, selections]) => filterKey !== 'time' && selections.length > 0)

  // True if pendingFilters differs from appliedFilters (used to enable/highlight the Apply button)
  const hasPendingChanges = JSON.stringify(pendingFilters) !== JSON.stringify(appliedFilters)

  // Converts the selected time filter label into an ISO timestamp
  // This timestamp is passed to /api/changes/recent as the 'since' parameter
  const getStartTimeFromFilter = () => {
    const selectedTimeRange = appliedFilters.time[0] || 'Last 24 Hours'
    if (selectedTimeRange === 'Last 1 Hour')  return new Date(Date.now() - 3600000).toISOString()
    if (selectedTimeRange === 'Last 7 Days')  return new Date(Date.now() - 7 * 86400000).toISOString()
    return todayMidnightISO  // default: Last 24 Hours = since midnight today
  }

  // load() — main data fetch function
  // Called on mount, every 30 seconds, and whenever appliedFilters changes
  // Fetches: subscriptions → resource groups → resource count → today's stats → recent change events
  const loadDashboardData = useCallback(async () => {
    setIsLoadingData(true)
    try {
      // Step 1: Fetch all Azure subscriptions the user has access to
      const subscriptionsResponse = await fetchSubscriptions()
      const subscriptions = Array.isArray(subscriptionsResponse) ? subscriptionsResponse : []
      setSubscriptionList(subscriptions)

      // Use the subscription from context (if user navigated from DriftScanner) or default to first
      const selectedSubscriptionId = activeSubscriptionId || subscriptions[0]?.id || ''
      if (!activeSubscriptionId && selectedSubscriptionId) setActiveSubscriptionId(selectedSubscriptionId)
      if (!selectedSubscriptionId) { setIsLoadingData(false); return }

      // Step 2: Fetch resource groups for the selected subscription
      const resourceGroups = await fetchResourceGroups(selectedSubscriptionId).catch(() => [])
      const resourceGroupArray = Array.isArray(resourceGroups) ? resourceGroups : []
      setResourceGroupList(resourceGroupArray)

      // Step 3: Count total resources across the first 10 resource groups (in parallel)
      let totalResources = 0
      await Promise.allSettled(resourceGroupArray.slice(0, 10).map(async resourceGroup => {
        const resourcesInGroup = await fetchResources(selectedSubscriptionId, resourceGroup.id || resourceGroup.name).catch(() => [])
        totalResources += Array.isArray(resourcesInGroup) ? resourcesInGroup.length : 0
      }))
      setTotalResourceCount(totalResources)

      // Step 4: Fetch today's stats for KPI cards and donut chart
      // Returns: { totalChanges, totalDrifted (unique resources changed), allTimeTotal }
      const statsForToday = await fetchStatsToday(selectedSubscriptionId).catch(() => null)
      setTodayStats(statsForToday)

      // Step 5: Fetch recent ARM change events for the table
      // Queries 'all-changes' blob (every ARM write/delete), NOT 'drift-records' (severity-classified drift only)
      // This is intentional — the dashboard is an infrastructure audit log, not just a drift log
      const selectedTimeRange = appliedFilters.time[0] || 'Last 24 Hours'
      const hoursToFetch = selectedTimeRange === 'Last 1 Hour' ? 1 : selectedTimeRange === 'Last 7 Days' ? 168 : 24

      // Map filter selections to API parameters
      const resourceGroupFilter = appliedFilters.resourceGroup[0] || undefined
      const callerFilter        = appliedFilters.username[0]      || undefined
      const changeTypeFilter    = appliedFilters.change[0] === 'Resource Deleted' ? 'deleted'
                                : appliedFilters.change[0] === 'Property Modified' || appliedFilters.change[0] === 'Tag Changed' ? 'modified'
                                : undefined

      const changeEvents = await fetchRecentChanges(selectedSubscriptionId, {
        resourceGroup: resourceGroupFilter,
        caller:        callerFilter,
        changeType:    changeTypeFilter,
        hours:         hoursToFetch,
        limit:         1000,
      }).catch(() => [])
      setRecentChangeEvents(Array.isArray(changeEvents) ? changeEvents : [])

    } catch (fetchError) {
      console.error('[DashboardHome] loadDashboardData error:', fetchError.message)
    } finally {
      setIsLoadingData(false)
    }
  }, [activeSubscriptionId, appliedFilters])

  // Run loadDashboardData on mount and whenever appliedFilters changes (e.g. user clicks Apply)
  useEffect(() => { loadDashboardData() }, [loadDashboardData])

  // Auto-refresh the dashboard every 30 seconds so KPIs stay current without a page reload
  useEffect(() => {
    const autoRefreshTimer = setInterval(() => loadDashboardData(), 30000)
    return () => clearInterval(autoRefreshTimer)  // cleanup on unmount
  }, [loadDashboardData])

  // Filter dropdown configuration — defines labels, icons, and available options for each filter
  // Options for resource, username are derived dynamically from the loaded change events
  const filterDropdownConfig = {
    time:          { label: 'Time',           icon: 'schedule',        options: ['Last 1 Hour', 'Last 24 Hours', 'Last 7 Days'] },
    subscription:  { label: 'Subscription',   icon: 'layers',          options: subscriptionList.map(sub => sub.name || sub.id) },
    resourceGroup: { label: 'Resource Group', icon: 'folder',          options: resourceGroupList.map(rg => rg.name || rg.id) },
    resource:      { label: 'Resource',       icon: 'dns',             options: [...new Set(recentChangeEvents.map(event => event.resourceId?.split('/').pop()).filter(Boolean))] },
    username:      { label: 'Username',       icon: 'person',          options: [...new Set(recentChangeEvents.map(event => event.caller).filter(Boolean))] },
    change:        { label: 'Change',         icon: 'compare_arrows',  options: ['Property Modified', 'Resource Deleted', 'Tag Changed'] },
  }

  // Client-side filtering applied on top of the server-side filtered results
  // Used for: search box text, resource name filter, tag-changed filter (API doesn't support these)
  const applyClientSideFilters = (allEvents) => {
    let filteredEvents = allEvents

    // Search box: filter by resourceId, resourceGroup, or caller containing the search text
    if (searchText) filteredEvents = filteredEvents.filter(event =>
      event.resourceId?.toLowerCase().includes(searchText.toLowerCase()) ||
      event.resourceGroup?.toLowerCase().includes(searchText.toLowerCase()) ||
      event.caller?.toLowerCase().includes(searchText.toLowerCase())
    )

    // Resource filter: only show events for the selected resource names
    if (appliedFilters.resource.length)
      filteredEvents = filteredEvents.filter(event => appliedFilters.resource.includes(event.resourceId?.split('/').pop()))

    // Tag Changed filter: only show events where the operation name contains 'tag'
    if (appliedFilters.change.includes('Tag Changed'))
      filteredEvents = filteredEvents.filter(event => (event.operationName || '').toLowerCase().includes('tag'))

    return filteredEvents
  }

  // The final list of events shown in the table after all filters are applied
  const filteredChangeEvents = applyClientSideFilters(recentChangeEvents)

  // Called when a table row is clicked — fetches fresh live ARM config and navigates to ComparisonPage
  // Passes the resource IDs and live config as React Router navigation state
  const navigateToComparison = async (changeEvent) => {
    let currentLiveState = changeEvent.liveState  // use stored state as fallback
    if (changeEvent.resourceId && changeEvent.subscriptionId && changeEvent.resourceGroup) {
      try {
        // Try to fetch the freshest live config from ARM
        currentLiveState = await fetchResourceConfiguration(changeEvent.subscriptionId, changeEvent.resourceGroup, changeEvent.resourceId)
      } catch { /* fall back to stored liveState if ARM fetch fails */ }
    }
    navigate('/comparison', {
      state: {
        subscriptionId: changeEvent.subscriptionId,
        resourceGroupId: changeEvent.resourceGroup,
        resourceId:     changeEvent.resourceId,
        resourceName:   changeEvent.resourceId?.split('/').pop(),
        liveState:      currentLiveState,
      }
    })
  }

  // Derived values for KPI cards — prefer stats from API, fall back to counting loaded events
  const kpiTotalChangesAllTime  = todayStats?.allTimeTotal  ?? todayStats?.totalChanges ?? recentChangeEvents.length
  const kpiResourcesChangedToday = todayStats?.totalDrifted ?? new Set(recentChangeEvents.map(e => e.resourceId)).size
  const kpiResourceGroupCount   = resourceGroupList.length
  const byHour = todayStats?.byHour ?? Array.from({ length: 24 }, (_, hour) => ({ hour, label: `${String(hour).padStart(2,'0')}:00`, count: 0 }))

  return (
    <div className="dh-root">
      <NavBar user={user} subscription={ctxSub} resourceGroup={resourceGroup} resource={resource} configData={configData} />

      <main className="dh-main">
        {/* KPI Cards */}
        <div className="dh-kpi-grid">
          <KpiCard label="Subscriptions"           value={subscriptionList.length}   icon="layers" />
          <KpiCard label="Resource Groups"         value={kpiResourceGroupCount}     icon="folder" />
          <KpiCard label="Total Resources"         value={totalResourceCount}        icon="dns" />
          <KpiCard label="Total Changes (All Time)" value={kpiTotalChangesAllTime}  icon="history" />
        </div>

        {/* Charts */}
        <div className="dh-charts-row">
          <DonutChart changed={kpiResourcesChangedToday} total={Math.max(totalResourceCount, kpiResourcesChangedToday)} />
          <BarChart subscriptionId={activeSubscriptionId} />
        </div>

        {/* Table */}
        <div className="dh-table-section">
          <div className="dh-table-header">
            <div className="dh-table-title-row">
              <h2 className="dh-table-title">Recent Events</h2>
              {recentChangeEvents.length > 0 && (
                <span className="dh-live-badge">
                  <span className="dh-live-dot" />
                  {recentChangeEvents.length} events
                </span>
              )}
            </div>
          </div>

          {/* Filter Bar */}
          <div className="dh-filter-bar">
            <div className="dh-filter-bar-left">
              <span className="material-symbols-outlined dh-filter-bar-icon">filter_list</span>
              {Object.entries(filterDropdownConfig).map(([filterKey, filterConfig]) => (
                <FilterDropdown key={filterKey} filterKey={filterKey} config={filterConfig}
                  selected={pendingFilters[filterKey]} onToggle={toggleFilterOption}
                  isOpen={openFilterKey === filterKey} onOpenToggle={setOpenFilterKey} />
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
            {isLoadingData ? (
              <div className="dh-empty">Loading changes...</div>
            ) : filteredChangeEvents.length === 0 ? (
              <div className="dh-empty">
                {activeSubscriptionId ? 'No changes found for the selected period.' : 'No subscription available.'}
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
                  {/* Render up to 100 rows — each row is one ARM change event */}
                  {filteredChangeEvents.slice(0, 1000).map((changeEvent, rowIndex) => {
                    // Extract the short resource name from the full ARM resource ID
                    const resourceShortName = changeEvent.resourceId?.split('/').pop() || '—'
                    // Shorten the operation name to the last two segments (e.g. storageAccounts/write)
                    const shortOperationName = (changeEvent.operationName || changeEvent.eventType || '').split('/').slice(-2).join('/')
                    const isDeleteEvent = changeEvent.changeType === 'deleted'
                    return (
                      <tr key={changeEvent._blobKey || rowIndex} className="dh-tr"
                        style={{ cursor: isDeleteEvent ? 'default' : 'pointer' }}
                        onClick={() => !isDeleteEvent && navigateToComparison(changeEvent)}
                        title={isDeleteEvent ? '' : 'Click to compare against baseline'}>
                        <td style={{ whiteSpace: 'nowrap', color: '#94a3b8', fontSize: 12 }}>
                          {changeEvent.detectedAt ? new Date(changeEvent.detectedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
                        </td>
                        <td style={{ color: '#60a5fa', fontWeight: 500 }}>{changeEvent.caller || '—'}</td>
                        <td className="dh-td-resource" title={changeEvent.resourceId}>{resourceShortName}</td>
                        <td>{changeEvent.resourceGroup || '—'}</td>
                        <td style={{ fontSize: 12, color: '#94a3b8', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={changeEvent.operationName}>{shortOperationName || '—'}</td>
                        <td>
                          <span style={{
                            display: 'inline-block', padding: '2px 8px', borderRadius: 10,
                            fontSize: 11, fontWeight: 600,
                            background: isDeleteEvent ? 'rgba(239,68,68,0.15)' : 'rgba(99,179,237,0.15)',
                            color: isDeleteEvent ? '#ef4444' : '#63b3ed',
                          }}>{changeEvent.changeType || 'modified'}</span>
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
