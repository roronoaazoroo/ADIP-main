// ============================================================
// FILE: src/components/DriftImpactDashboard.jsx
// ROLE: Drift Impact Analysis tab — real data from driftIndex Table
//
// Shows:
//   - Daily drift volume bar chart (last 7/14/30 days)
//   - Severity distribution (critical/high/medium/low counts)
//   - Top drifted resources ranked list
//   - Risk by resource group
//
// Props: subscriptionId
// No new dependencies — uses inline SVG for charts (same pattern as DashboardHome BarChart)
// ============================================================
import React, { useState, useEffect } from 'react'
import { fetchDriftImpact, fetchResourceDriftEvents } from '../services/api'

const ENV_SUB_ID = import.meta.env.VITE_AZURE_SUBSCRIPTION_ID || ''
const PERIOD_OPTIONS = [7, 14, 30]

const SEV_COLOR = { critical: '#ef4444', high: '#f97316', medium: '#f59e0b', low: '#10b981' }
const RISK_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' }

// Simple inline SVG bar chart
function BarChart({ data, height = 120 }) {
  if (!data?.length) return null
  const max = Math.max(...data.map(d => d.count), 1)
  const barW = Math.max(4, Math.floor(560 / data.length) - 2)
  return (
    <svg width="100%" viewBox={`0 0 ${data.length * (barW + 2)} ${height + 24}`} style={{ overflow: 'visible' }}>
      {data.map((d, i) => {
        const barH = Math.max(2, Math.round((d.count / max) * height))
        const x = i * (barW + 2)
        const y = height - barH
        return (
          <g key={i}>
            <rect x={x} y={y} width={barW} height={barH} rx={2}
              fill={d.count > 0 ? '#0060a9' : '#f1f5f9'} />
            {i % Math.ceil(data.length / 7) === 0 && (
              <text x={x + barW / 2} y={height + 16} textAnchor="middle"
                fontSize={9} fill="#6b7280">{d.label}</text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

// SVG pie chart — no dependencies
function PieChart({ data }) {
  const total = data.reduce((s, d) => s + d.value, 0)
  if (!total) return <div style={{ color: '#64748b', fontSize: 13 }}>No drift events in this period.</div>

  let cumAngle = -Math.PI / 2  // start at top
  const cx = 90, cy = 90, r = 75

  const slices = data.filter(d => d.value > 0).map(d => {
    const angle = (d.value / total) * 2 * Math.PI
    const x1 = cx + r * Math.cos(cumAngle)
    const y1 = cy + r * Math.sin(cumAngle)
    cumAngle += angle
    const x2 = cx + r * Math.cos(cumAngle)
    const y2 = cy + r * Math.sin(cumAngle)
    const large = angle > Math.PI ? 1 : 0
    // Label position
    const midAngle = cumAngle - angle / 2
    const lx = cx + (r + 18) * Math.cos(midAngle)
    const ly = cy + (r + 18) * Math.sin(midAngle)
    return { ...d, x1, y1, x2, y2, large, lx, ly, pct: Math.round((d.value / total) * 100) }
  })

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 24, flexWrap: 'wrap' }}>
      <svg width={180} height={180} viewBox="0 0 180 180">
        {slices.map((s, i) => (
          <path key={i}
            d={`M${cx},${cy} L${s.x1},${s.y1} A${r},${r} 0 ${s.large},1 ${s.x2},${s.y2} Z`}
            fill={s.color} opacity={0.9} />
        ))}
        {/* Center hole */}
        <circle cx={cx} cy={cy} r={38} fill="var(--panel-bg, #fff)" />
        <text x={cx} y={cy - 6} textAnchor="middle" fontSize={18} fontWeight={700} fill="#003359">{total}</text>
        <text x={cx} y={cy + 12} textAnchor="middle" fontSize={9} fill="#6b7280">total drifts</text>
      </svg>
      {/* Legend */}
      <div>
        {slices.map((s, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: s.color, display: 'inline-block', flexShrink: 0 }} />
            <span style={{ fontSize: 13, color: '#374151', textTransform: 'capitalize', minWidth: 60 }}>{s.label}</span>
            <span style={{ fontSize: 13, color: '#6b7280' }}>{s.value} <span style={{ color: '#9ca3af' }}>({s.pct}%)</span></span>
          </div>
        ))}
      </div>
    </div>
  )
}

// Expandable panel showing full drift event history for one resource
function ResourceDriftEvents({ subscriptionId, resourceId }) {
  const [events,  setEvents]  = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchResourceDriftEvents(subscriptionId, resourceId, 10)
      .then(setEvents)
      .catch(() => setEvents([]))
      .finally(() => setLoading(false))
  }, [subscriptionId, resourceId])

  if (loading) return <div style={{ padding: '10px 16px', color: '#6b7280', fontSize: 12 }}>Loading events...</div>
  if (!events?.length) return <div style={{ padding: '10px 16px', color: '#6b7280', fontSize: 12 }}>No detailed events found.</div>

  return (
    <div style={{ background: '#f9f9fc', borderTop: '1px solid #f1f5f9' }}>
      {events.map((ev, i) => (
        <div key={i} style={{ padding: '10px 20px', borderBottom: '1px solid #f1f5f9' }}>
          {/* Event header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: ev.differences.length ? 8 : 0, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
              color: SEV_COLOR[ev.severity] || '#6b7280',
              background: `${SEV_COLOR[ev.severity]}18`, padding: '2px 7px', borderRadius: 4 }}>
              {ev.severity}
            </span>
            <span style={{ fontSize: 12, color: '#6b7280' }}>
              {ev.detectedAt ? new Date(ev.detectedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
            </span>
            {ev.caller && ev.caller !== 'Unknown' && (
              <span style={{ fontSize: 12, color: '#374151' }}>by <strong>{ev.caller}</strong></span>
            )}
            <span style={{ fontSize: 11, color: '#6b7280' }}>
              {ev.changeCount} change{ev.changeCount !== 1 ? 's' : ''}
            </span>
          </div>
          {/* Change bullets */}
          {ev.differences.map((d, j) => (
            <div key={j} style={{ fontSize: 12, color: '#6b7280', paddingLeft: 12, marginBottom: 2, display: 'flex', gap: 6 }}>
              <span style={{ color: '#9ca3af' }}>•</span>
              <span style={{ color: '#374151' }}>{d.sentence || d.path}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

export default function DriftImpactDashboard({ subscriptionId: propSubId }) {
  const [subInput, setSubInput] = useState(propSubId || ENV_SUB_ID)
  const [days,     setDays]     = useState(30)
  const [data,     setData]     = useState(null)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState(null)
  const [expandedResource, setExpandedResource] = useState(null)
  const [expandedRG,       setExpandedRG]       = useState(null)

  const effectiveSubId = propSubId || subInput

  useEffect(() => { if (propSubId) setSubInput(propSubId) }, [propSubId])

  useEffect(() => {
    if (!effectiveSubId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchDriftImpact(effectiveSubId, days)
      .then(d  => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setError(e.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [effectiveSubId, days])

  const total = data?.totalDrifts || 0

  return (
    <div>
      {/* Header controls */}
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
        {loading && <span style={{ fontSize: 12, color: '#6b7280' }}>Loading...</span>}
      </div>

      {error && <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 16 }}>{error}</div>}

      {data && (
        <>
          {/* KPI row */}
          <div className="an-kpi-grid" style={{ marginBottom: 20 }}>
            <div className="an-kpi-card">
              <div className="an-kpi-header"><span className="an-kpi-label">Total Drift Events</span><span className="material-symbols-outlined an-kpi-icon">warning</span></div>
              <div className="an-kpi-value-row"><span className="an-kpi-value">{total}</span></div>
            </div>
            <div className="an-kpi-card">
              <div className="an-kpi-header"><span className="an-kpi-label">Critical</span><span className="material-symbols-outlined an-kpi-icon" style={{ color: '#ef4444' }}>error</span></div>
              <div className="an-kpi-value-row"><span className="an-kpi-value" style={{ color: '#ef4444' }}>{data.severityTotals.critical}</span></div>
            </div>
            <div className="an-kpi-card">
              <div className="an-kpi-header"><span className="an-kpi-label">High</span><span className="material-symbols-outlined an-kpi-icon" style={{ color: '#f97316' }}>warning_amber</span></div>
              <div className="an-kpi-value-row"><span className="an-kpi-value" style={{ color: '#f97316' }}>{data.severityTotals.high}</span></div>
            </div>
            <div className="an-kpi-card">
              <div className="an-kpi-header"><span className="an-kpi-label">Resources Affected</span><span className="material-symbols-outlined an-kpi-icon">dns</span></div>
              <div className="an-kpi-value-row"><span className="an-kpi-value">{data.topResources.length}</span></div>
            </div>
          </div>

          <div className="an-grid-2">
            {/* Daily drift volume */}
            <div className="an-card">
              <div className="an-card-header">
                <div className="an-card-title-row">
                  <span className="material-symbols-outlined an-card-icon">bar_chart</span>
                  <h2 className="an-card-title">Drift Volume by Day</h2>
                </div>
              </div>
              <div className="an-card-body">
                <BarChart data={data.dailyVolume} />
              </div>
            </div>

            {/* Severity distribution */}
            <div className="an-card">
              <div className="an-card-header">
                <div className="an-card-title-row">
                  <span className="material-symbols-outlined an-card-icon">donut_large</span>
                  <h2 className="an-card-title">Severity Distribution</h2>
                </div>
              </div>
              <div className="an-card-body">
                <PieChart data={Object.entries(data.severityTotals).map(([label, value]) => ({ label, value, color: SEV_COLOR[label] }))} />
              </div>
            </div>

            {/* Top drifted resources */}
            <div className="an-card">
              <div className="an-card-header">
                <div className="an-card-title-row">
                  <span className="material-symbols-outlined an-card-icon">leaderboard</span>
                  <h2 className="an-card-title">Most Drifted Resources</h2>
                </div>
              </div>
              <div className="an-card-body an-card-body--table">
                {data.topResources.length === 0 ? (
                  <div style={{ color: '#6b7280', fontSize: 13 }}>No drift events in this period.</div>
                ) : (
                  <table className="an-table">
                    <thead><tr><th>Resource</th><th>Drifts</th><th>Max Severity</th><th style={{ width: 40 }}></th></tr></thead>
                    <tbody>
                      {data.topResources.map((r, i) => (
                        <>
                          <tr key={i} className="an-tr" style={{ cursor: 'pointer' }}
                            onClick={() => setExpandedResource(expandedResource === r.resourceId ? null : r.resourceId)}>
                            <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.name}</td>
                            <td>{r.driftCount}</td>
                            <td style={{ color: SEV_COLOR[r.maxSeverity], textTransform: 'capitalize', fontWeight: 600 }}>{r.maxSeverity}</td>
                            <td>
                              <span className="material-symbols-outlined" style={{ fontSize: 16, color: '#6b7280' }}>
                                {expandedResource === r.resourceId ? 'expand_less' : 'expand_more'}
                              </span>
                            </td>
                          </tr>
                          {expandedResource === r.resourceId && (
                            <tr key={`${i}-detail`}>
                              <td colSpan={4} style={{ padding: 0 }}>
                                <ResourceDriftEvents subscriptionId={effectiveSubId} resourceId={r.resourceId} />
                              </td>
                            </tr>
                          )}
                        </>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

            {/* Risk by resource group */}
            <div className="an-card">
              <div className="an-card-header">
                <div className="an-card-title-row">
                  <span className="material-symbols-outlined an-card-icon">shield</span>
                  <h2 className="an-card-title">Risk by Resource Group</h2>
                </div>
              </div>
              <div className="an-card-body">
                {data.resourceGroupRisk.length === 0 ? (
                  <div style={{ color: '#6b7280', fontSize: 13 }}>No drift events in this period.</div>
                ) : (
                  data.resourceGroupRisk.map((rg, i) => {
                    const rgResources = data.topResources.filter(r => r.resourceGroup === rg.resourceGroup)
                    const isExpanded  = expandedRG === rg.resourceGroup
                    return (
                      <div key={i}>
                        <div className="an-risk-row" style={{ cursor: rgResources.length ? 'pointer' : 'default' }}
                          onClick={() => rgResources.length && setExpandedRG(isExpanded ? null : rg.resourceGroup)}>
                          <div className="an-risk-info">
                            <span className="an-risk-name">{rg.resourceGroup}</span>
                            <span className="an-risk-meta">{rg.driftCount} drifts · {rg.critical}C {rg.high}H {rg.medium}M {rg.low}L</span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 12, fontWeight: 600, color: SEV_COLOR[rg.riskLevel], textTransform: 'capitalize' }}>
                              {RISK_LABEL[rg.riskLevel]}
                            </span>
                            {rgResources.length > 0 && (
                              <span className="material-symbols-outlined" style={{ fontSize: 16, color: '#6b7280' }}>
                                {isExpanded ? 'expand_less' : 'expand_more'}
                              </span>
                            )}
                          </div>
                        </div>
                        {isExpanded && (
                          <div style={{ background: '#f9f9fc', borderRadius: 6, margin: '4px 0 8px 0', padding: '6px 0' }}>
                            {rgResources.map((r, j) => (
                              <div key={j} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 16px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <span className="material-symbols-outlined" style={{ fontSize: 15, color: '#6b7280' }}>dns</span>
                                  <span style={{ fontFamily: 'monospace', fontSize: 12, color: '#003359' }}>{r.name}</span>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                  <span style={{ fontSize: 11, color: '#6b7280' }}>{r.driftCount} drift{r.driftCount !== 1 ? 's' : ''}</span>
                                  <span style={{ fontSize: 11, fontWeight: 600, color: SEV_COLOR[r.maxSeverity], textTransform: 'capitalize' }}>{r.maxSeverity}</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
