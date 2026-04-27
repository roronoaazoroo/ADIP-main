// FILE: src/components/RollbackHistory.jsx
// ROLE: Displays the rollback audit trail for a resource on GenomePage

// Shows every rollback ever performed — when it happened, which snapshot
// was restored, and whether that snapshot is still the current baseline.

// Props:
//   subscriptionId — Azure subscription ID
//   resourceId     — Full ARM resource ID

'use strict'
import React, { useState, useEffect } from 'react'
import { fetchRollbackHistory } from '../services/api'

export default function RollbackHistory({ subscriptionId, resourceId }) {
  // List of rollback events fetched from /api/genome/rollback-history
  const [rollbackEvents,    setRollbackEvents]    = useState([])
  const [isLoading,         setIsLoading]         = useState(false)
  const [errorMessage,      setErrorMessage]      = useState(null)

  useEffect(() => {
    if (!subscriptionId || !resourceId) return
    setIsLoading(true)
    setErrorMessage(null)
    fetchRollbackHistory(subscriptionId, resourceId)
      .then(events => setRollbackEvents(events || []))
      .catch(fetchError => setErrorMessage(fetchError.message))
      .finally(() => setIsLoading(false))
  }, [subscriptionId, resourceId])

  if (isLoading) {
    return (
      <div className="gp-loading">
        <div className="gp-loading-ring" />
        <span>Loading rollback history...</span>
      </div>
    )
  }

  if (errorMessage) {
    return <div className="gp-alert gp-alert--error">{errorMessage}</div>
  }

  if (rollbackEvents.length === 0) {
    return (
      <div className="gp-timeline-empty">
        <span className="material-symbols-outlined" style={{ fontSize: 48, color: '#94a3b8' }}>history</span>
        <p>No rollbacks have been performed on this resource yet.</p>
      </div>
    )
  }

  return (
    <div className="gp-rollback-history">
      <p className="gp-rollback-history-subtitle">
        {rollbackEvents.length} rollback{rollbackEvents.length !== 1 ? 's' : ''} performed
      </p>

      {rollbackEvents.map((rollbackEvent, index) => (
        <div key={rollbackEvent.blobKey || index} className="gp-rollback-event">

          {/* Timeline connector dot */}
          <div className="gp-rollback-dot" />

          <div className="gp-rollback-event-content">
            {/* Rollback timestamp */}
            <div className="gp-rollback-event-header">
              <span className="material-symbols-outlined" style={{ fontSize: 16, color: '#0060a9' }}>history</span>
              <span className="gp-rollback-event-time">
                {new Date(rollbackEvent.rolledBackAt).toLocaleString()}
              </span>
              {rollbackEvent.isCurrentBaseline && (
                <span className="gp-rollback-badge gp-rollback-badge--active">Current Baseline</span>
              )}
            </div>

            {/* Snapshot details */}
            <div className="gp-rollback-event-detail">
              Rolled back to snapshot:&nbsp;
              <strong>{rollbackEvent.snapshotLabel}</strong>
              &nbsp;(saved {new Date(rollbackEvent.savedAt).toLocaleDateString()})
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
