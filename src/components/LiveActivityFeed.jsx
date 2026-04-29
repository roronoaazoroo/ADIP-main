// FILE: src/components/LiveActivityFeed.jsx
// ROLE: Real-time activity feed shown on the DriftScanner Activity tab

// Props:
//   liveEvents      — scan animation log entries (type, message, timestamp)
//                     shown as simple log lines at the top of the feed
//   driftEvents     — real ARM change events received via Socket.IO
//                     shown as detailed drift cards with field-level changes
//   isScanning      — true while the scan animation is playing
//   isMonitoring    — true while the monitoring session is active
//   socketConnected — true when the Socket.IO connection is live

// Key functions:
//   resolveUser(ev)  — extracts a human-readable caller name from an event
//                      tries ev.caller, then ARM claims, then sessionStorage user
//   downloadCSV()    — exports all events (both liveEvents and driftEvents) as a CSV file
//   userFilter       — dropdown to filter driftEvents by a specific caller
//   uniqueUsers      — derived from driftEvents, used to populate the filter dropdown
//   filtered         — driftEvents after applying userFilter
//   logRef           — ref to the scroll container, auto-scrolls to bottom on new events

import React, { useRef, useEffect, useState, useMemo } from 'react'
import './LiveActivityFeed.css'

function resolveUser(ev) {
  if (ev.caller && ev.caller !== 'unknown' && ev.caller !== 'Unknown user' && ev.caller !== 'System') return ev.caller
  if (ev.caller === 'System' || !ev.caller) {
    const svc = (ev.operationName || '').split('/')[0]?.replace('Microsoft.', '') || 'System'
    return `System (${svc})`
  }
  try { const sessionUser = JSON.parse(sessionStorage.getItem('user') || '{}'); return sessionUser.name || sessionUser.username || 'Unknown user' }
  catch { return 'Unknown user' }
}

export default function LiveActivityFeed({ liveEvents, driftEvents, isScanning, isMonitoring, socketConnected, onClear }) {
  // Ref to the scroll container — used to auto-scroll to the bottom on new events
  const logRef = useRef(null)

  const isHumanCaller = (name) => {
    if (!name || !name.trim()) return false
    const c = name.trim().toLowerCase()
    return c !== 'system' && !c.startsWith('system (') && c !== 'manual-compare' && !c.startsWith('azure ')
  }

  // The currently selected user in the filter dropdown (empty string = show all users)
  const [selectedUserFilter, setSelectedUserFilter] = useState('')

  // Only human callers — exclude System/blank from feed and dropdown
  const humanDriftEvents = useMemo(() => driftEvents.filter(ev => isHumanCaller(resolveUser(ev))), [driftEvents])

  // Unique list of caller names derived from humanDriftEvents — populates the filter dropdown
  const uniqueCallerNames = useMemo(() => [...new Set(humanDriftEvents.map(resolveUser))].sort(), [humanDriftEvents])

  // driftEvents after applying the user filter (or all events if no filter selected)
  const filteredDriftEvents = useMemo(
    () => selectedUserFilter ? humanDriftEvents.filter(ev => resolveUser(ev) === selectedUserFilter) : humanDriftEvents,
    [humanDriftEvents, selectedUserFilter]
  )

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [liveEvents, driftEvents])

  const downloadCSV = () => {
    const rows = [['Time','User','Action','Resource','ResourceType','ResourceGroup','Operation','FieldsChanged','Changes']]
    liveEvents.forEach(ev => rows.push([ev.timestamp||'','',ev.type||'','','','',ev.message||'','','']))
    driftEvents.forEach(ev => {
      const user = resolveUser(ev)
      const time = ev.eventTime ? new Date(ev.eventTime).toLocaleString() : ev._receivedAt || ''
      const isDelete = ev.eventType?.includes('Delete')
      const isCreate = ev.operationName?.toLowerCase().includes('write') && !ev.hasPrevious
      const action = isDelete ? 'deleted' : isCreate ? 'created' : 'modified'
      const changesText = (ev.changes||[]).map(changeItem => {
        const fieldPath = (changeItem.path||'').split(' → ').filter(segment => segment && segment !== '_childConfig').slice(-3).join('.')
        const oldValueStr = changeItem.oldValue != null ? String(typeof changeItem.oldValue === 'object' ? JSON.stringify(changeItem.oldValue) : changeItem.oldValue) : ''
        const newValueStr = changeItem.newValue != null ? String(typeof changeItem.newValue === 'object' ? JSON.stringify(changeItem.newValue) : changeItem.newValue) : ''
        return oldValueStr && newValueStr ? `${fieldPath}: ${oldValueStr} -> ${newValueStr}`
             : oldValueStr ? `${fieldPath}: removed (was ${oldValueStr})`
             : `${fieldPath}: added (${newValueStr})`
      }).join(' | ')
      rows.push([time, user, action, ev.resourceId?.split('/').pop()||'', ev.resourceId?.split('/')?.[7]||'', ev.resourceGroup||'', ev.operationName||'', ev.changes?.length||0, changesText])
    })
    const csvContent = rows.map(row => row.map(cellValue => `"${String(cellValue).replace(/"/g,'""')}"`).join(',')).join('\n')
    const downloadLink = document.createElement('a')
    downloadLink.href = URL.createObjectURL(new Blob([csvContent], { type: 'text/csv' }))
    downloadLink.download = `adip-activity-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`
    downloadLink.click()
    URL.revokeObjectURL(downloadLink.href)
  }

  return (
    <section className="panel panel-live" role="feed" aria-label="Live activity feed">
      <div className="panel-body panel-body-log" ref={logRef}>
        {/* Header controls */}
        <div className="feed-controls" style={{ marginBottom: 12, justifyContent: 'flex-end' }}>
          <span className="panel-badge" aria-label={`${driftEvents.length} events detected`}>{driftEvents.length} events</span>
          {uniqueCallerNames.length > 0 && (
            <select
              value={selectedUserFilter}
              onChange={e=>setSelectedUserFilter(e.target.value)}
              className="feed-user-filter"
              aria-label="Filter events by user"
            >
              <option value=''>All users</option>
              {uniqueCallerNames.map(callerName=><option key={callerName} value={callerName}>{callerName}</option>)}
            </select>
          )}
          {(liveEvents.length > 0 || driftEvents.length > 0) && (
            <button onClick={downloadCSV} title="Download all events as CSV" className="feed-csv-btn" aria-label="Download events as CSV">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              CSV
            </button>
          )}
        </div>

        {liveEvents.length === 0 && driftEvents.length === 0 && (
          <div className="panel-empty" role="status">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            <p>Activity log will appear here during operations</p>
            <p style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>Start a scan or enable monitoring to see real-time changes</p>
          </div>
        )}

        {liveEvents.map(ev => (
          <div key={ev.id} className={`log-entry log-entry-${ev.type}`}>
            <span className="log-time">{ev.timestamp}</span>
            <span className="log-message">{ev.message}</span>
          </div>
        ))}

        {filteredDriftEvents.length > 0 && <div className="drift-feed-divider"><span>Live resource changes</span></div>}

        {filteredDriftEvents.map(ev => {
          const callerDisplayName  = resolveUser(ev)
          const resourceShortName  = ev.resourceId?.split('/').pop() ?? ev.subject ?? 'resource'
          const resourceTypeName   = ev.resourceId?.split('/')?.[7] ?? ''
          const isDeleteEvent      = ev.eventType?.includes('Delete')
          const isCreateEvent      = ev.operationName?.toLowerCase().includes('write') && !ev.hasPrevious
          const actionLabel        = isDeleteEvent ? 'deleted' : isCreateEvent ? 'created' : 'modified'
          const formattedEventTime = ev.eventTime ? new Date(ev.eventTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ev._receivedAt
          const shortOperationName = ev.operationName?.split('/')?.slice(-1)[0] ?? ''

          return (
            <div key={ev._clientId} className="drift-event-row">
              <div className="drift-event-header">
                <span className="drift-time">{formattedEventTime}</span>
                <span className="drift-user-badge">{callerDisplayName}</span>
                <span className={`drift-action drift-action--${actionLabel}`}>{actionLabel}</span>
                <span className="drift-resource-name">{resourceShortName}</span>
                {resourceTypeName && <span className="drift-resource-type">{resourceTypeName}</span>}
                {shortOperationName && shortOperationName !== 'write' && shortOperationName !== 'delete' && <span className="drift-operation">via {shortOperationName}</span>}
                {ev.resourceGroup && <span className="drift-resource-group">in {ev.resourceGroup}</span>}
                {ev.changes?.length > 0 && <span className="drift-field-count">{ev.changes.length} field{ev.changes.length>1?'s':''} changed</span>}
              </div>
              {ev.changes?.length > 0 && (
                <div className="drift-changes">
                  {ev.changes.slice(0, 8).map((changeItem, changeIndex) => {
                    const pathSegments    = (changeItem.path||'').split(' → ').filter(seg => seg && seg !== '_childConfig')
                    const displayPath     = pathSegments.slice(-3).join(' → ')  // show last 3 segments to keep it readable
                    const displayOldValue = changeItem.oldValue != null ? String(typeof changeItem.oldValue === 'object' ? JSON.stringify(changeItem.oldValue) : changeItem.oldValue).slice(0, 50) : null
                    const displayNewValue = changeItem.newValue != null ? String(typeof changeItem.newValue === 'object' ? JSON.stringify(changeItem.newValue) : changeItem.newValue).slice(0, 50) : null
                    const changeTypeCssClass = `drift-change-type--${(changeItem.type||'modified').replace(' ', '-')}`
                    return (
                      <div key={changeIndex} className="drift-change-row">
                        <span className={`drift-change-type ${changeTypeCssClass}`}>{changeItem.type?.replace('-', ' ')}</span>
                        <span className="drift-change-path">{displayPath}</span>
                        {displayOldValue != null && displayNewValue != null && <span><span className="drift-change-old">{displayOldValue}</span><span className="drift-change-arrow">→</span><span className="drift-change-new">{displayNewValue}</span></span>}
                        {displayOldValue != null && displayNewValue == null && <span className="drift-change-label" style={{color:'var(--color-danger)'}}>was: {displayOldValue}</span>}
                        {displayOldValue == null && displayNewValue != null && <span className="drift-change-label" style={{color:'var(--color-success)'}}>now: {displayNewValue}</span>}
                      </div>
                    )
                  })}
                  {ev.changes.length > 8 && <div className="drift-more-fields">+{ev.changes.length-8} more fields</div>}
                </div>
              )}
              {(!ev.changes||ev.changes.length===0) && ev.operationName && (
                <div className="drift-operation-detail">
                  operation: <span className="drift-operation-name">{ev.operationName}</span>
                  {!ev.hasPrevious && <span className="drift-hint">(submit again to enable field-level diff)</span>}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
