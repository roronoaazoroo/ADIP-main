// ============================================================
// FILE: src/components/LiveActivityFeed.jsx
// ROLE: Live Activity Feed 2.0 — real-time infrastructure change stream
// ============================================================
import React, { useRef, useEffect, useState, useMemo } from 'react'
import './LiveActivityFeed.css'
import MultiSelectDropdown from './MultiSelectDropdown'

const SEVERITY_COLORS = { critical: '#ef4444', high: '#f97316', medium: '#f59e0b', low: '#10b981' }

function resolveUser(ev) {
  if (ev.caller && ev.caller !== 'unknown' && ev.caller !== 'Unknown user' && ev.caller !== 'System') return ev.caller
  if (!ev.caller || ev.caller === 'System') {
    const svc = (ev.operationName || '').split('/')[0]?.replace('Microsoft.', '') || 'System'
    return `System (${svc})`
  }
  return 'Unknown'
}

function isHumanCaller(name) {
  if (!name?.trim()) return false
  const c = name.trim().toLowerCase()
  return c !== 'system' && !c.startsWith('system (') && c !== 'manual-compare' && !c.startsWith('azure ')
}

function timeAgo(dateStr) {
  if (!dateStr) return ''
  const diff = Date.now() - new Date(dateStr).getTime()
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function LiveActivityFeed({ liveEvents, driftEvents, isScanning, isMonitoring, socketConnected, onClear }) {
  const logRef = useRef(null)
  const [filter, setFilter] = useState({ user: '', action: '', severity: '' })
  const [expanded, setExpanded] = useState(null)
  const [autoScroll, setAutoScroll] = useState(true)

  const humanEvents = useMemo(() => driftEvents.filter(ev => isHumanCaller(resolveUser(ev))), [driftEvents])

  const filtered = useMemo(() => {
    let result = humanEvents
    if (filter.user) result = result.filter(ev => resolveUser(ev) === filter.user)
    if (filter.action) result = result.filter(ev => {
      const isDelete = ev.eventType?.includes('Delete')
      const isCreate = ev.operationName?.toLowerCase().includes('write') && !ev.hasPrevious
      const action = isDelete ? 'deleted' : isCreate ? 'created' : 'modified'
      return action === filter.action
    })
    if (filter.severity) result = result.filter(ev => ev.severity === filter.severity)
    return result
  }, [humanEvents, filter])

  const uniqueUsers = useMemo(() => [...new Set(humanEvents.map(resolveUser))].sort(), [humanEvents])

  useEffect(() => {
    if (autoScroll && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [driftEvents, autoScroll])

  const handleScroll = () => {
    if (!logRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = logRef.current
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50)
  }

  const downloadCSV = () => {
    const rows = [['Time', 'User', 'Action', 'Resource', 'Type', 'ResourceGroup', 'Severity', 'Fields Changed', 'Details']]
    filtered.forEach(ev => {
      const action = ev.eventType?.includes('Delete') ? 'deleted' : (!ev.hasPrevious ? 'created' : 'modified')
      const changes = (ev.changes || []).map(c => `${c.path}: ${c.oldValue ?? ''} → ${c.newValue ?? ''}`).join(' | ')
      rows.push([ev.eventTime || '', resolveUser(ev), action, ev.resourceId?.split('/').pop() || '', ev.resourceId?.split('/')?.[7] || '', ev.resourceGroup || '', ev.severity || '', ev.changes?.length || 0, changes])
    })
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.download = `adip-activity-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
  }

  return (
    <section className="laf2" role="feed" aria-label="Live activity feed">
      {/* Status bar */}
      <div className="laf2-status">
        <div className="laf2-status-left">
          <span className={`laf2-dot ${socketConnected ? 'laf2-dot--live' : 'laf2-dot--off'}`} />
          <span className="laf2-status-text">{socketConnected ? 'Live' : 'Disconnected'}</span>
          {isMonitoring && <span className="laf2-badge laf2-badge--monitoring">Monitoring</span>}
          {isScanning && <span className="laf2-badge laf2-badge--scanning">Scanning</span>}
        </div>
        <div className="laf2-status-right">
          <span className="laf2-count">{filtered.length} event{filtered.length !== 1 ? 's' : ''}</span>
          <button onClick={downloadCSV} className="laf2-btn" title="Export CSV">↓ CSV</button>
          {onClear && <button onClick={onClear} className="laf2-btn" title="Clear">✕</button>}
        </div>
      </div>

      {/* Filters */}
      {humanEvents.length > 0 && (
        <div className="laf2-filters">
          <div className="laf2-filter-wrap">
            <MultiSelectDropdown
              options={[{label: 'All users', value: ''}, ...uniqueUsers.map(u => ({label: u, value: u}))]}
              selected={[filter.user].filter(Boolean)}
              onChange={val => setFilter(f => ({ ...f, user: val[0] || '' }))}
              placeholder="All users"
              singleSelect={true}
            />
          </div>
          <div className="laf2-filter-wrap">
            <MultiSelectDropdown
              options={[
                {label: 'All actions', value: ''},
                {label: 'Created', value: 'created'},
                {label: 'Modified', value: 'modified'},
                {label: 'Deleted', value: 'deleted'}
              ]}
              selected={[filter.action].filter(Boolean)}
              onChange={val => setFilter(f => ({ ...f, action: val[0] || '' }))}
              placeholder="All actions"
              singleSelect={true}
            />
          </div>
          <div className="laf2-filter-wrap">
            <MultiSelectDropdown
              options={[
                {label: 'All severity', value: ''},
                {label: 'Critical', value: 'critical'},
                {label: 'High', value: 'high'},
                {label: 'Medium', value: 'medium'},
                {label: 'Low', value: 'low'}
              ]}
              selected={[filter.severity].filter(Boolean)}
              onChange={val => setFilter(f => ({ ...f, severity: val[0] || '' }))}
              placeholder="All severity"
              singleSelect={true}
            />
          </div>
          {(filter.user || filter.action || filter.severity) && (
            <button onClick={() => setFilter({ user: '', action: '', severity: '' })} className="laf2-btn">Clear</button>
          )}
        </div>
      )}

      {/* Event stream */}
      <div className="laf2-stream" ref={logRef} onScroll={handleScroll}>
        {/* Scan log entries */}
        {liveEvents.map(ev => (
          <div key={ev.id} className={`laf2-log laf2-log--${ev.type}`}>
            <span className="laf2-log-time">{ev.timestamp}</span>
            <span className="laf2-log-msg">{ev.message}</span>
          </div>
        ))}

        {/* Empty state */}
        {liveEvents.length === 0 && filtered.length === 0 && (
          <div className="laf2-empty">
            <p>Waiting for infrastructure changes...</p>
            <p className="laf2-empty-sub">Changes to monitored resources will appear here in real-time</p>
          </div>
        )}

        {/* Drift events */}
        {filtered.map(ev => {
          const caller = resolveUser(ev)
          const resource = ev.resourceId?.split('/').pop() || 'resource'
          const resourceType = ev.resourceId?.split('/')?.[7] || ''
          const isDelete = ev.eventType?.includes('Delete')
          const isCreate = ev.operationName?.toLowerCase().includes('write') && !ev.hasPrevious
          const action = isDelete ? 'deleted' : isCreate ? 'created' : 'modified'
          const isExpanded = expanded === ev._clientId
          const severity = ev.severity || (ev.changes?.length > 5 ? 'medium' : 'low')

          return (
            <div
              key={ev._clientId}
              className={`laf2-event laf2-event--${action}`}
              onClick={() => setExpanded(isExpanded ? null : ev._clientId)}
              role="article"
            >
              {/* Severity indicator */}
            <div className="laf2-event-body">
                {/* Main row */}
                <div className="laf2-event-main">
                  
                  <span className="laf2-event-caller">{caller}</span>
                  <span className={`laf2-event-action laf2-event-action--${action}`}>{action}</span>
                  <span className="laf2-event-resource">{resource}</span>
                  {resourceType && <span className="laf2-event-type">{resourceType}</span>}
                  {ev.resourceGroup && <span className="laf2-event-rg">{ev.resourceGroup}</span>}
                  <span className="laf2-event-time">{timeAgo(ev.eventTime)}</span>
                </div>

                {/* Change summary (always visible) */}
                {ev.changes?.length > 0 && !isExpanded && (
                  <div className="laf2-event-summary">
                    {ev.changes.length} field{ev.changes.length > 1 ? 's' : ''} changed
                    {ev.changes.length <= 3 && ': '}
                    {ev.changes.slice(0, 3).map((c, i) => (
                      <span key={i} className="laf2-event-field">{(c.path || '').split(' → ').pop()}</span>
                    ))}
                    {ev.changes.length > 3 && <span className="laf2-event-more">+{ev.changes.length - 3} more</span>}
                  </div>
                )}

                {/* Expanded detail */}
                {isExpanded && ev.changes?.length > 0 && (
                  <div className="laf2-event-detail">
                    {ev.changes.slice(0, 12).map((c, i) => {
                      const path = (c.path || '').split(' → ').filter(s => s && s !== '_childConfig').slice(-3).join(' → ')
                      const oldVal = c.oldValue != null ? String(typeof c.oldValue === 'object' ? JSON.stringify(c.oldValue) : c.oldValue).slice(0, 60) : null
                      const newVal = c.newValue != null ? String(typeof c.newValue === 'object' ? JSON.stringify(c.newValue) : c.newValue).slice(0, 60) : null
                      return (
                        <div key={i} className="laf2-change">
                          <span className={`laf2-change-type laf2-change-type--${(c.type || 'modified').replace(' ', '-')}`}>{c.type}</span>
                          <span className="laf2-change-path">{path}</span>
                          {oldVal && newVal && <><span className="laf2-change-old">{oldVal}</span><span className="laf2-change-arrow">→</span><span className="laf2-change-new">{newVal}</span></>}
                          {oldVal && !newVal && <span className="laf2-change-removed">removed: {oldVal}</span>}
                          {!oldVal && newVal && <span className="laf2-change-added">added: {newVal}</span>}
                        </div>
                      )
                    })}
                    {ev.changes.length > 12 && <div className="laf2-change-overflow">+{ev.changes.length - 12} more changes</div>}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Auto-scroll indicator */}
      {!autoScroll && filtered.length > 5 && (
        <button className="laf2-scroll-btn" onClick={() => { setAutoScroll(true); if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }}>
          ↓ New events
        </button>
      )}
    </section>
  )
}
