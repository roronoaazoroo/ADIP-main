// ============================================================
// FILE: src/components/ChangeAttribution.jsx
// ROLE: Change Attribution tab on AnalyticsPage
//
// Shows per-identity breakdown of ARM changes and drift events
// sourced from changesIndex + driftIndex Tables (real data).
//
// Props: subscriptionId, days (default 30)
// ============================================================
import React, { useState, useEffect, useCallback } from 'react'
import { fetchChangeAttribution } from '../services/api'

const RISK_COLORS = {
  critical: { bg: 'rgba(239,68,68,0.12)',  text: '#ef4444' },
  high:     { bg: 'rgba(249,115,22,0.12)', text: '#f97316' },
  medium:   { bg: 'rgba(245,158,11,0.12)', text: '#f59e0b' },
  low:      { bg: 'rgba(16,185,129,0.12)', text: '#10b981' },
}

const PERIOD_OPTIONS = [7, 14, 30, 90]

// Fallback subscription ID from env — used when context has no selection yet
const ENV_SUB_ID = import.meta.env.VITE_AZURE_SUBSCRIPTION_ID || ''

export default function ChangeAttribution({ subscriptionId: propSubId }) {
  const [subInput,  setSubInput]  = useState(propSubId || ENV_SUB_ID)
  const [days,      setDays]      = useState(30)
  const [rows,      setRows]      = useState([])
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState(null)

  const effectiveSubId = propSubId || subInput

  useEffect(() => { if (propSubId) setSubInput(propSubId) }, [propSubId])

  const load = useCallback(async () => {
    if (!effectiveSubId) return
    setLoading(true)
    setError(null)
    try {
      const data = await fetchChangeAttribution(effectiveSubId, days)
      setRows(data || [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [effectiveSubId, days])

  useEffect(() => { load() }, [load])

  return (
    <div className="an-card an-card--full">
      <div className="an-card-header">
        <div className="an-card-title-row">
          <span className="material-symbols-outlined an-card-icon">group</span>
          <h2 className="an-card-title">Change Attribution Report</h2>
          {rows.length > 0 && <span className="an-card-badge">{rows.length} identities</span>}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {/* Period selector */}
          <div className="an-range-btns">
            {PERIOD_OPTIONS.map(d => (
              <button key={d} className={`an-range-btn ${days === d ? 'an-range-btn--active' : ''}`}
                onClick={() => setDays(d)}>{d}d</button>
            ))}
          </div>
          <button className="an-range-btn" onClick={load} disabled={loading} title="Refresh">
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>refresh</span>
          </button>
        </div>
      </div>

      <div className="an-card-body an-card-body--table">
        {/* Subscription input when not provided via context */}
        {!propSubId && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <span style={{ fontSize: 13, color: '#94a3b8' }}>Subscription ID</span>
            <input className="an-report-sub-input" type="text"
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              value={subInput} onChange={e => setSubInput(e.target.value.trim())} />
            <button className="an-generate-btn" onClick={load} disabled={loading || !subInput}>Load</button>
          </div>
        )}

        {loading && <div style={{ color: '#94a3b8', fontSize: 13, padding: '12px 0' }}>Loading...</div>}
        {error   && <div style={{ color: '#ef4444', fontSize: 13, padding: '12px 0' }}>{error}</div>}

        {!loading && !error && rows.length === 0 && (
          <div style={{ color: '#64748b', fontSize: 13, padding: '12px 0' }}>
            No change events found for this subscription in the last {days} days.
          </div>
        )}

        {rows.length > 0 && (
          <table className="an-table">
            <thead>
              <tr>
                <th>Identity</th>
                <th>Total Changes</th>
                <th>Drift Events</th>
                <th>Top Resource Type</th>
                <th>Risk Level</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const risk = RISK_COLORS[row.riskLevel] || RISK_COLORS.low
                const isUser = row.caller && row.caller !== 'System' && !row.caller.includes('-')
                return (
                  <tr key={i} className="an-tr">
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className="material-symbols-outlined" style={{ color: isUser ? '#8b5cf6' : '#1995ff', fontSize: 18 }}>
                          {isUser ? 'person' : 'engineering'}
                        </span>
                        {row.caller || 'System'}
                      </div>
                    </td>
                    <td>{row.totalChanges.toLocaleString()}</td>
                    <td>
                      <span className="an-sev-badge" style={{ background: risk.bg, color: risk.text }}>
                        {row.driftCount} drift{row.driftCount !== 1 ? 's' : ''}
                      </span>
                    </td>
                    <td className="an-td-type">{row.topResourceType}</td>
                    <td style={{ textTransform: 'capitalize', color: risk.text }}>{row.riskLevel}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
