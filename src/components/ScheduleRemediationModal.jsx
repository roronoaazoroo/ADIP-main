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
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="cp-card" style={{ width: 460, padding: 24, background: 'var(--panel-bg)', boxShadow: '0 10px 30px rgba(0,0,0,0.25)' }}>
        <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="material-symbols-outlined" style={{ color: 'var(--primary)' }}>schedule</span>
          Schedule Remediation
        </h3>

        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 20 }}>
          The fix will be applied automatically at the scheduled time.
          {severity === 'medium' && ' Unresolved medium-severity drift escalates to high after 48 hours.'}
        </p>

        {/* Maintenance window */}
        <div className="sp-form-field" style={{ marginBottom: 16 }}>
          <label className="sp-form-label">Maintenance Window</label>
          <input type="datetime-local" className="sp-input"
            value={scheduledAt}
            min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
            onChange={e => setScheduledAt(e.target.value)}
            style={{ width: '100%' }}
          />
        </div>

        {/* Auto-approval */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', marginBottom: 8 }}>
            <input type="checkbox" checked={autoApproval} onChange={e => setAutoApproval(e.target.checked)} />
            Auto-approve if no response within
          </label>
          {autoApproval && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 24 }}>
              <input type="number" className="sp-input" min={1} max={168} value={autoApprovalHours}
                onChange={e => setAutoApprovalHours(Number(e.target.value))}
                style={{ width: 70 }} />
              <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>hours</span>
            </div>
          )}
        </div>

        {error && <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 12 }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <button className="cp-btn cp-btn--secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="cp-btn cp-btn--primary" onClick={handleConfirm}
            disabled={saving || !scheduledAt}>
            {saving ? 'Scheduling...' : 'Confirm Schedule'}
          </button>
        </div>
      </div>
    </div>
  )
}
