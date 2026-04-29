// FILE: src/components/DriftForecastChart.jsx
// ROLE: Interactive stacked bar chart showing real drift frequency from Azure Blob Storage.
//       Supports range toggle (7/14/30 days), severity filter, hover tooltips, click-to-filter.

import { useEffect, useState, useCallback } from 'react'
import { fetchDriftHistory } from '../services/driftPredictionApi'
import './DriftForecastChart.css'

const SEV_COLOR = { critical: '#ef4444', high: '#f97316', medium: '#f59e0b', low: '#10b981' }
const SEV_ORDER = ['critical', 'high', 'medium', 'low']
const RANGES    = [7, 14, 30]

function buildBuckets(records, days) {
  const buckets = {}
  for (let i = days - 1; i >= 0; i--) {
    const d   = new Date(Date.now() - i * 86400000)
    const key = d.toISOString().slice(0, 10)
    buckets[key] = {
      date:     key,
      label:    days <= 14
        ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      critical: 0, high: 0, medium: 0, low: 0, total: 0,
    }
  }
  ;(Array.isArray(records) ? records : []).forEach(r => {
    const day = r.detectedAt?.slice(0, 10)
    if (buckets[day] && SEV_ORDER.includes(r.severity)) {
      buckets[day][r.severity]++
      buckets[day].total++
    }
  })
  return Object.values(buckets)
}

export default function DriftForecastChart({ subscriptionId, resourceId }) {
  const [records,    setRecords]    = useState([])
  const [loading,    setLoading]    = useState(false)
  const [range,      setRange]      = useState(14)
  const [hiddenSev,  setHiddenSev]  = useState(new Set())
  const [tooltip,    setTooltip]    = useState(null)   // { bar, x, y }

  useEffect(() => {
    if (!subscriptionId || !resourceId) return
    setLoading(true)
    fetchDriftHistory(subscriptionId, resourceId)
      .then(r => setRecords(Array.isArray(r) ? r : []))
      .catch(() => setRecords([]))
      .finally(() => setLoading(false))
  }, [subscriptionId, resourceId])

  const toggleSev = useCallback(sev => {
    setHiddenSev(prev => {
      const next = new Set(prev)
      next.has(sev) ? next.delete(sev) : next.add(sev)
      return next
    })
  }, [])

  const bars    = buildBuckets(records, range)
  const visSevsArr = SEV_ORDER.filter(s => !hiddenSev.has(s))
  const maxTotal = Math.max(...bars.map(b => visSevsArr.reduce((s, sv) => s + b[sv], 0)), 1)

  // Summary stats
  const totalEvents  = records.length
  const criticalCount = records.filter(r => r.severity === 'critical').length
  const activeDays   = bars.filter(b => b.total > 0).length
  const peakDay      = bars.reduce((a, b) => b.total > a.total ? b : a, bars[0] || {})

  // SVG dimensions
  const W = 700, H = 180, PAD_L = 36, PAD_B = 28, PAD_T = 16
  const barW   = (W - PAD_L) / bars.length
  const barGap = Math.max(barW * 0.15, 2)
  const innerW = barW - barGap

  // Label every Nth bar to avoid crowding
  const labelEvery = range <= 7 ? 1 : range <= 14 ? 2 : 5

  if (loading) return (
    <div className="dfc-wrap">
      <div className="dfc-loading"><div className="dfc-spinner" />Loading drift history…</div>
    </div>
  )

  return (
    <div className="dfc-wrap">
      {/* Summary stats */}
      <div className="dfc-stats">
        <div className="dfc-stat">
          <div className="dfc-stat-value">{totalEvents}</div>
          <div className="dfc-stat-label">Total Drift Events</div>
        </div>
        <div className="dfc-stat">
          <div className="dfc-stat-value" style={{ color: '#ef4444' }}>{criticalCount}</div>
          <div className="dfc-stat-label">Critical Events</div>
        </div>
        <div className="dfc-stat">
          <div className="dfc-stat-value">{activeDays}</div>
          <div className="dfc-stat-label">Active Days</div>
        </div>
        <div className="dfc-stat">
          <div className="dfc-stat-value">{peakDay?.total || 0}</div>
          <div className="dfc-stat-label">Peak Day ({peakDay?.label || '—'})</div>
        </div>
      </div>

      {/* Controls */}
      <div className="dfc-controls">
        {RANGES.map(r => (
          <button key={r} className={`dfc-range-btn${range === r ? ' dfc-range-btn--active' : ''}`}
            onClick={() => setRange(r)}>{r}d</button>
        ))}
        <div className="dfc-sev-filter">
          {SEV_ORDER.map(sev => (
            <button key={sev}
              className={`dfc-sev-btn${!hiddenSev.has(sev) ? ' dfc-sev-btn--active' : ''}`}
              style={{ background: `${SEV_COLOR[sev]}18`, borderColor: SEV_COLOR[sev], color: SEV_COLOR[sev] }}
              onClick={() => toggleSev(sev)}
            >{sev}</button>
          ))}
        </div>
      </div>

      {/* Chart */}
      {totalEvents === 0 ? (
        <div className="dfc-empty">No drift events in the last {range} days for this resource.</div>
      ) : (
        <div className="dfc-chart-area">
          <svg viewBox={`0 0 ${W} ${H + PAD_B + PAD_T}`} className="dfc-svg-wrap"
            onMouseLeave={() => setTooltip(null)}>

            {/* Y-axis grid lines + labels */}
            {[0, 0.25, 0.5, 0.75, 1].map((pct, i) => {
              const y = PAD_T + (H - pct * H)
              const val = Math.round(pct * maxTotal)
              return (
                <g key={i}>
                  <line x1={PAD_L} y1={y} x2={W} y2={y} stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
                  <text x={PAD_L - 4} y={y + 4} textAnchor="end" fontSize="9" fill="#475569">{val}</text>
                </g>
              )
            })}

            {/* Stacked bars */}
            {bars.map((bar, i) => {
              const x = PAD_L + i * barW + barGap / 2
              let stackY = PAD_T + H  // start from bottom

              return (
                <g key={bar.date}
                  onMouseEnter={e => {
                    const svgRect = e.currentTarget.closest('svg').getBoundingClientRect()
                    const barCenterX = PAD_L + i * barW + barW / 2
                    setTooltip({ bar, svgX: barCenterX, svgW: W, i })
                  }}
                >
                  {visSevsArr.map(sev => {
                    const count = bar[sev]
                    if (!count) return null
                    const barH = Math.max((count / maxTotal) * H, 3)
                    stackY -= barH
                    return (
                      <rect key={sev} className="dfc-bar"
                        x={x} y={stackY} width={innerW} height={barH}
                        fill={SEV_COLOR[sev]} rx="2"
                      />
                    )
                  })}

                  {/* Count label on top of bar */}
                  {bar.total > 0 && (
                    <text x={x + innerW / 2} y={stackY - 3}
                      textAnchor="middle" fontSize="9" fill="#6b7280" fontWeight="600">
                      {bar.total}
                    </text>
                  )}

                  {/* X-axis label */}
                  {i % labelEvery === 0 && (
                    <text x={x + innerW / 2} y={PAD_T + H + PAD_B - 4}
                      textAnchor="middle" fontSize="9" fill="#475569">
                      {bar.label}
                    </text>
                  )}
                </g>
              )
            })}

            {/* X-axis line */}
            <line x1={PAD_L} y1={PAD_T + H} x2={W} y2={PAD_T + H} stroke="#2d3748" strokeWidth="1" />
          </svg>

          {/* Tooltip — positioned absolutely relative to chart area */}
          {tooltip && (() => {
            const leftPct = (tooltip.svgX / tooltip.svgW) * 100
            const topOffset = -10
            return (
              <div className="dfc-tooltip" style={{ left: `${leftPct}%`, top: topOffset }}>
                <div className="dfc-tooltip-date">{tooltip.bar.label}</div>
                {SEV_ORDER.filter(s => tooltip.bar[s] > 0).map(sev => (
                  <div key={sev} className="dfc-tooltip-row">
                    <span><span className="dfc-tooltip-dot" style={{ background: SEV_COLOR[sev] }} />{sev}</span>
                    <strong>{tooltip.bar[sev]}</strong>
                  </div>
                ))}
                <div className="dfc-tooltip-row dfc-tooltip-total">
                  <span>Total</span><strong>{tooltip.bar.total}</strong>
                </div>
              </div>
            )
          })()}
        </div>
      )}

      {/* Legend — clickable to toggle severity */}
      <div className="dfc-legend">
        {SEV_ORDER.map(sev => (
          <span key={sev} className="dfc-legend-item" onClick={() => toggleSev(sev)}
            style={{ opacity: hiddenSev.has(sev) ? 0.35 : 1 }}>
            <span className="dfc-legend-dot" style={{ background: SEV_COLOR[sev] }} />
            {sev}
          </span>
        ))}
        <span style={{ fontSize: 11, color: '#475569', marginLeft: 'auto' }}>Click legend to filter</span>
      </div>
    </div>
  )
}
