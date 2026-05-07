// FILE: src/components/CostImpactDashboard.jsx
// ROLE: Feature A — Cost Impact tab on Analytics page

// Shows:
//   - Total monthly savings from remediations (last 30/90 days)
//   - Per-remediation savings breakdown
//   - "Potential savings if all drift remediated" (from driftIndex)

import React, { useState, useEffect } from 'react'
import { fetchCostSavings } from '../services/api'

const ENV_SUB_ID = import.meta.env.VITE_AZURE_SUBSCRIPTION_ID || ''
const PERIOD_OPTIONS = [7, 30, 90]

export default function CostImpactDashboard({ subscriptionId: propSubId }) {
  const [subInput, setSubInput] = useState(propSubId || ENV_SUB_ID)
  const [days,     setDays]     = useState(30)
  const [data,     setData]     = useState(null)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState(null)

  const effectiveSubId = propSubId || subInput

  useEffect(() => { if (propSubId) setSubInput(propSubId) }, [propSubId])

  useEffect(() => {
    if (!effectiveSubId) return
    let cancelled = false
    setLoading(true)
    fetchCostSavings(effectiveSubId, days)
      .then(d  => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [effectiveSubId, days])

  return (
    <div>
      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
        {!propSubId && (
          <input className="an-report-sub-input" type="text" placeholder="Subscription ID"
            value={subInput} onChange={e => setSubInput(e.target.value.trim())} style={{ maxWidth: 300 }} />
        )}
        <div className="an-range-btns">
          {PERIOD_OPTIONS.map(d => (
            <button key={d} className={`an-range-btn ${days === d ? 'an-range-btn--active' : ''}`}
              onClick={() => setDays(d)}>{d}d</button>
          ))}
        </div>
        {loading && <span style={{ fontSize: 12, color: '#94a3b8' }}>Loading...</span>}
      </div>

      {error && <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 16 }}>{error}</div>}

      {data && (
        <>
          {/* KPI */}
          <div className="an-kpi-grid" style={{ marginBottom: 20 }}>
            <div className="an-kpi-card">
              <div className="an-kpi-header">
                <span className="an-kpi-label">Total Savings (Last {days}d)</span>
                <span className="material-symbols-outlined an-kpi-icon" style={{ color: '#10b981' }}>savings</span>
              </div>
              <div className="an-kpi-value-row">
                <span className="an-kpi-value" style={{ color: '#10b981' }}>
                  {data.totalMonthlySavings >= 0 ? '+' : ''}${Math.abs(data.totalMonthlySavings).toFixed(2)}
                </span>
                <span style={{ fontSize: 11, color: '#64748b', marginLeft: 4 }}>/mo</span>
              </div>
            </div>
            <div className="an-kpi-card">
              <div className="an-kpi-header">
                <span className="an-kpi-label">Remediations with Cost Impact</span>
                <span className="material-symbols-outlined an-kpi-icon">auto_fix_high</span>
              </div>
              <div className="an-kpi-value-row">
                <span className="an-kpi-value">{data.records?.length || 0}</span>
              </div>
            </div>
          </div>

          {/* Savings breakdown */}
          <div className="an-card an-card--full">
            <div className="an-card-header">
              <div className="an-card-title-row">
                <span className="material-symbols-outlined an-card-icon">receipt_long</span>
                <h2 className="an-card-title">Remediation Savings Breakdown</h2>
              </div>
            </div>
            <div className="an-card-body an-card-body--table">
              {!data.records?.length ? (
                <div style={{ color: '#64748b', fontSize: 13 }}>
                  No cost-impacting remediations in this period. Cost savings are recorded when SKU, access tier, or encryption changes are remediated.
                </div>
              ) : (
                <table className="an-table">
                  <thead>
                    <tr><th>Resource</th><th>What Changed</th><th>Remediated At</th><th>Monthly Impact</th></tr>
                  </thead>
                  <tbody>
                    {data.records.map((r, i) => {
                      const saving = r.monthlySavings || 0
                      const color  = saving > 0 ? '#10b981' : '#ef4444'
                      const fields = r.changedFields || []
                      return (
                        <tr key={i} className="an-tr">
                          <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.resourceId?.split('/').pop()}</td>
                          <td style={{ fontSize: 12 }}>
                            {fields.length > 0 ? fields.map((f, j) => (
                              <div key={j} style={{ marginBottom: 2 }}>
                                <span style={{ color: '#94a3b8' }}>{f.field?.split(' → ').pop() || f.field}</span>
                                {': '}
                                <span style={{ color: '#ef4444' }}>{String(f.from).slice(0, 20)}</span>
                                {' → '}
                                <span style={{ color: '#10b981' }}>{String(f.to).slice(0, 20)}</span>
                              </div>
                            )) : <span style={{ color: '#64748b' }}>—</span>}
                          </td>
                          <td style={{ fontSize: 12, color: '#94a3b8' }}>{r.remediatedAt ? new Date(r.remediatedAt).toLocaleString() : '—'}</td>
                          <td style={{ color, fontWeight: 700 }}>{saving > 0 ? '+' : ''}${Math.abs(saving).toFixed(2)}/mo</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
