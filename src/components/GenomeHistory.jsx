// FILE: src/components/GenomeHistory.jsx
// ROLE: Displays the full activity history for a resource's genome snapshots

// Shows every genome event in chronological order:
//   created   — snapshot was saved
//   promoted  — snapshot was set as the golden baseline
//   rolledBack — resource was reverted to this snapshot via ARM PUT
//   deleted   — snapshot was deleted

// Props:
//   subscriptionId — Azure subscription ID
//   resourceId     — Full ARM resource ID
import React, { useState, useEffect } from 'react'
import { fetchGenomeHistory } from '../services/api'

// Icon and label for each event type
const EVENT_CONFIG = {
  created:    { icon: 'add_circle',     label: 'Snapshot created',          color: '#10b981' },
  promoted:   { icon: 'star',           label: 'Set as golden baseline',     color: '#f59e0b' },
  rolledBack: { icon: 'history',        label: 'Resource rolled back to',    color: '#1995ff' },
  deleted:    { icon: 'delete',         label: 'Snapshot deleted',           color: '#ef4444' },
}

export default function GenomeHistory({ subscriptionId, resourceId }) {
  const [historyEvents, setHistoryEvents] = useState([])
  const [isLoading,     setIsLoading]     = useState(false)
  const [errorMessage,  setErrorMessage]  = useState(null)

  useEffect(() => {
    if (!subscriptionId || !resourceId) return
    setIsLoading(true)
    setErrorMessage(null)
    fetchGenomeHistory(subscriptionId, resourceId)
      .then(events => setHistoryEvents(events || []))
      .catch(fetchError => setErrorMessage(fetchError.message))
      .finally(() => setIsLoading(false))
  }, [subscriptionId, resourceId])

  if (isLoading) {
    return (
      <div className="gp-loading">
        <div className="gp-loading-ring" />
        <span>Loading genome history...</span>
      </div>
    )
  }

  if (errorMessage) {
    return <div className="gp-alert gp-alert--error">{errorMessage}</div>
  }

  if (historyEvents.length === 0) {
    return (
      <div className="gp-timeline-empty">
        <span className="material-symbols-outlined" style={{ fontSize: 36, color: '#c2c7d0' }}>manage_history</span>
        <p>No genome activity recorded for this resource yet.</p>
      </div>
    )
  }

  return (
    <div className="gp-rollback-history">
      <p className="gp-rollback-history-subtitle">
        {historyEvents.length} event{historyEvents.length !== 1 ? 's' : ''} recorded
      </p>

      {historyEvents.map((historyEvent, index) => {
        const config = EVENT_CONFIG[historyEvent.eventType] || EVENT_CONFIG.created
        return (
          <div key={`${historyEvent.blobKey}-${historyEvent.eventType}-${index}`} className="gp-rollback-event">
            {/* Colored dot per event type */}
            <div className="gp-rollback-dot" style={{ background: config.color }} />

            <div className="gp-rollback-event-content">
              <div className="gp-rollback-event-header">
                <span className="material-symbols-outlined" style={{ fontSize: 14, color: config.color }}>
                  {config.icon}
                </span>
                <span className="gp-rollback-event-time">
                  {new Date(historyEvent.eventAt).toLocaleString()}
                </span>
                {historyEvent.isCurrentBaseline && historyEvent.eventType !== 'deleted' && (
                  <span className="gp-rollback-badge gp-rollback-badge--active">Current Baseline</span>
                )}
              </div>
              <div className="gp-rollback-event-detail">
                {config.label}:&nbsp;<strong>{historyEvent.snapshotLabel}</strong>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
