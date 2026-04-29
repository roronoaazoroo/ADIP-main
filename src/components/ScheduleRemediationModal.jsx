// ============================================================
// FILE: src/components/ScheduleRemediationModal.jsx
// ROLE: Modal for scheduling a remediation with maintenance window
//       and auto-approval timeout. Used in ComparisonPage.
//
// Props:
//   subscriptionId, resourceGroupId, resourceId, severity
//   onClose()     — called on cancel or after successful schedule
//   onScheduled() — called with the created schedule object
// ============================================================
import React, { useState } from 'react'
import { scheduleRemediation } from '../services/api'
import './ScheduleRemediationModal.css'

// Returns a datetime-local string 1 hour from now (default maintenance window)
function defaultScheduleTime() {
  const d = new Date(Date.now() + 3600000)
  return d.toISOString().slice(0, 16)
}

export default function ScheduleRemediationModal({ subscriptionId, resourceGroupId, resourceId, severity, onClose, onScheduled }) {
  const [scheduledAt,       setScheduledAt]       = useState(defaultScheduleTime())
  const [autoApprovalHours, setAutoApprovalHours] = useState(24)
  const [autoApproval,      setAutoApproval]      = useState(true)
  const [saving,            setSaving]            = useState(false)
  const [error,             setError]             = useState(null)

  const handleConfirm = async () => {
    setSaving(true)
    setError(null)
    try {
      const schedule = await scheduleRemediation({
        subscriptionId,
        resourceGroupId,
        resourceId,
        severity,
        scheduledAt: new Date(scheduledAt).toISOString(),
        autoApprovalHours: autoApproval ? autoApprovalHours : null,
      })
      onScheduled(schedule)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="srm-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
    >
      <div className="srm-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-modal-title">
        <h3 id="schedule-modal-title" className="srm-header">
          <span className="material-symbols-outlined srm-header-icon">schedule</span>
          Schedule Remediation
        </h3>

        <p className="srm-desc">
          The fix will be applied automatically at the scheduled time.
          {severity === 'medium' && ' Unresolved medium-severity drift escalates to high after 48 hours.'}
        </p>

        {/* Maintenance window */}
        <div className="srm-field-group">
          <label className="srm-label" htmlFor="schedule-datetime">Maintenance Window</label>
          <input id="schedule-datetime" type="datetime-local" className="srm-input"
            value={scheduledAt}
            min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
            onChange={e => setScheduledAt(e.target.value)}
            aria-required="true"
          />
        </div>

        {/* Auto-approval */}
        <div className="srm-field-group">
          <label className="srm-checkbox-label">
            <input type="checkbox" className="srm-checkbox" checked={autoApproval} onChange={e => setAutoApproval(e.target.checked)} />
            Auto-approve if no response within
          </label>
          {autoApproval && (
            <div className="srm-timeout-row">
              <input type="number" className="srm-input srm-timeout-input" min={1} max={168} value={autoApprovalHours}
                onChange={e => setAutoApprovalHours(Number(e.target.value))}
                aria-label="Auto-approval timeout in hours"
              />
              <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>hours</span>
            </div>
          )}
        </div>

        {error && (
          <div className="srm-error" role="alert">
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>error</span>
            {error}
          </div>
        )}

        <div className="srm-actions">
          <button className="cp-btn cp-btn--secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="cp-btn cp-btn--primary" onClick={handleConfirm}
            disabled={saving || !scheduledAt}
            aria-busy={saving}>
            {saving ? (
              <><div className="cp-spinner" style={{ marginRight: 6 }} />Scheduling...</>
            ) : 'Confirm Schedule'}
          </button>
        </div>
      </div>
    </div>
  )
}
