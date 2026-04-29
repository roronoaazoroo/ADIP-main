// FILE: src/components/ResourceDriftPrediction.jsx
// ROLE: Bubble chart — X=time, Y=normalised severity score (0-10),
//   bubble radius ∝ totalDrifts. One bubble per resource per active day.
//   Interactive: hover tooltip, click legend to isolate, 7d/30d toggle.

import { useEffect, useState, useRef, useCallback } from 'react'
import { getAzureIconUrl } from '../utils/azureIcons'
import './ResourceDriftPrediction.css'

const BASE        = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api'
const LINE_COLORS = ['#3b82f6','#ef4444','#10b981','#f59e0b','#8b5cf6','#06b6d4','#f97316','#ec4899','#84cc16','#6366f1']
const SEV_COLOR   = { critical: '#ef4444', high: '#f97316', medium: '#f59e0b', low: '#10b981' }

// SVG viewport
const VW = 900, VH = 280, PL = 52, PR = 20, PT = 20, PB = 48

// Normalise raw score to 0–10
function normalise(score, maxScore) {
  return maxScore > 0 ? Math.round((score / maxScore) * 10 * 10) / 10 : 0
}

function xPos(i, total) { return PL + (i / Math.max(total - 1, 1)) * (VW - PL - PR) }
function yPos(norm)     { return PT + VH - (norm / 10) * VH }

// ── Tooltip ───────────────────────────────────────────────────────────────────
function Tooltip({ bubble }) {
  if (!bubble) return null
  const { s, score, norm, date, color } = bubble
  const worst = ['critical','high','medium','low'].find(sv => s.severities[sv] > 0) || 'low'
  return (
    <div className="rdp-tooltip">
      <div className="rdp-tt-header">
        {getAzureIconUrl(s.type, s.name) && <img src={getAzureIconUrl(s.type, s.name)} alt="" width="14" height="14" />}
        <span className="rdp-tt-name">{s.name}</span>
        <span className="rdp-tt-badge" style={{ color: SEV_COLOR[worst], borderColor: SEV_COLOR[worst] }}>{worst}</span>
      </div>
      <div className="rdp-tt-row"><span>Date</span><b>{date}</b></div>
      <div className="rdp-tt-row"><span>Severity score</span><b style={{ color }}>{norm} / 10</b></div>
      <div className="rdp-tt-row"><span>Total drifts</span><b>{s.totalDrifts}</b></div>
      <div className="rdp-tt-row">
        <span>Breakdown</span>
        <span className="rdp-tt-sevs">
          {s.severities.critical > 0 && <span style={{ color: '#ef4444' }}>C:{s.severities.critical}</span>}
          {s.severities.high     > 0 && <span style={{ color: '#f97316' }}>H:{s.severities.high}</span>}
          {s.severities.medium   > 0 && <span style={{ color: '#f59e0b' }}>M:{s.severities.medium}</span>}
          {s.severities.low      > 0 && <span style={{ color: '#10b981' }}>L:{s.severities.low}</span>}
        </span>
      </div>
      {s.topFields.length > 0 && (
        <div className="rdp-tt-fields">{s.topFields.map((f, i) => <span key={i}>{f}</span>)}</div>
      )}
      {s.lastDrift && <div className="rdp-tt-row"><span>Last drift</span><b>{s.lastDrift.slice(0,10)}</b></div>}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function ResourceDriftPrediction({ subscriptionId, resourceGroup }) {
  const [days,    setDays]    = useState(30)
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(false)
  const [hovered, setHovered] = useState(null)   // { s, score, norm, date, color, cx, cy }
  const [focused, setFocused] = useState(null)   // resource name to isolate

  useEffect(() => {
    if (!subscriptionId) return
    setLoading(true); setData(null)
    const p = new URLSearchParams({ subscriptionId, days })
    if (resourceGroup) p.set('resourceGroup', resourceGroup)
    fetch(`${BASE}/drift-risk-timeline?${p}`)
      .then(r => r.json()).then(setData).catch(() => setData(null)).finally(() => setLoading(false))
  }, [subscriptionId, resourceGroup, days])

  const toggleFocus = useCallback(name => setFocused(f => f === name ? null : name), [])

  if (!subscriptionId) return <div className="rdp-empty">Select a subscription on the Drift Scanner first.</div>
  if (loading)         return <div className="rdp-loading"><div className="rdp-spinner" />Loading drift risk timeline…</div>
  if (!data?.series?.length) return <div className="rdp-empty">No drift history found for existing resources.</div>

  const { dates, series } = data

  // Global max score across all resources — used for normalisation
  const globalMax = Math.max(...series.flatMap(s => s.scores), 1)

  // Bubble radius: min 4, max 22, proportional to totalDrifts
  const maxDrifts = Math.max(...series.map(s => s.totalDrifts), 1)
  const bubbleR   = s => 4 + (s.totalDrifts / maxDrifts) * 18

  const visibleSeries = focused ? series.filter(s => s.name === focused) : series

  // Y-axis ticks 0–10
  const yTicks = [0, 2, 4, 6, 8, 10]

  // X-axis: show every Nth label
  const labelEvery = days === 7 ? 1 : 5

  return (
    <div className="rdp-wrap">
      {/* Header */}
      <div className="rdp-header">
        <div>
          <h3 className="rdp-title">Drift Risk Bubble Chart</h3>
          <p className="rdp-subtitle">
            Y = severity score (0–10) · Bubble size = total drifts · Existing resources only
          </p>
        </div>
        <div className="rdp-toggle">
          {[7, 30].map(d => (
            <button key={d} className={`rdp-toggle-btn${days === d ? ' rdp-toggle-btn--active' : ''}`}
              onClick={() => setDays(d)}>{d}d</button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className="rdp-chart-wrap" onMouseLeave={() => setHovered(null)}>
        <svg viewBox={`0 0 ${VW + PL + PR} ${VH + PT + PB}`} className="rdp-svg">

          {/* Y-axis grid + labels */}
          {yTicks.map(v => {
            const y = yPos(v)
            return (
              <g key={v}>
                <line x1={PL} y1={y} x2={VW + PL - PR} y2={y} stroke="#f1f5f9" strokeWidth="1" />
                <text x={PL - 6} y={y + 4} textAnchor="end" fontSize="10" fill="#cbd5e1">{v}</text>
              </g>
            )
          })}

          {/* X-axis labels */}
          {dates.map((d, i) => i % labelEvery === 0 && (
            <text key={i} x={xPos(i, dates.length)} y={PT + VH + 16}
              textAnchor="middle" fontSize="9" fill="#cbd5e1">
              {new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            </text>
          ))}

          {/* Axes */}
          <line x1={PL} y1={PT} x2={PL} y2={PT + VH} stroke="#e2e8f0" strokeWidth="1" />
          <line x1={PL} y1={PT + VH} x2={VW + PL - PR} y2={PT + VH} stroke="#e2e8f0" strokeWidth="1" />

          {/* Y-axis label */}
          <text x={12} y={PT + VH / 2} textAnchor="middle" fontSize="10" fill="#94a3b8"
            transform={`rotate(-90, 12, ${PT + VH / 2})`}>Severity Score</text>

          {/* Bubbles */}
          {visibleSeries.map((s, si) => {
            const color  = LINE_COLORS[series.indexOf(s) % LINE_COLORS.length]
            const dimmed = focused && focused !== s.name
            const r      = bubbleR(s)

            return s.scores.map((score, di) => {
              if (score === 0) return null
              const norm = normalise(score, globalMax)
              const cx   = xPos(di, dates.length)
              const cy   = yPos(norm)
              const isHovered = hovered?.s.name === s.name && hovered?.date === dates[di]

              return (
                <g key={`${s.name}-${di}`}
                  onMouseEnter={() => setHovered({ s, score, norm, date: dates[di], color, cx, cy })}
                  onMouseLeave={() => setHovered(null)}
                  onClick={() => toggleFocus(s.name)}
                  style={{ cursor: 'pointer' }}
                >
                  <circle cx={cx} cy={cy} r={isHovered ? r + 3 : r}
                    fill={color}
                    fillOpacity={dimmed ? 0.12 : isHovered ? 0.9 : 0.65}
                    stroke={color}
                    strokeWidth={isHovered ? 2 : 1}
                    strokeOpacity={dimmed ? 0.2 : 1}
                    style={{ transition: 'r 0.15s, fill-opacity 0.15s' }}
                  />
                  {/* Score label inside bubble if large enough */}
                  {r >= 12 && !dimmed && (
                    <text cx={cx} cy={cy + 4} textAnchor="middle" fontSize="9"
                      fill="#fff" fontWeight="600" style={{ pointerEvents: 'none' }}>
                      {norm}
                    </text>
                  )}
                </g>
              )
            })
          })}

          {/* Resource name labels below X-axis — one per resource at its peak day */}
          {visibleSeries.map((s, si) => {
            const color   = LINE_COLORS[series.indexOf(s) % LINE_COLORS.length]
            const dimmed  = focused && focused !== s.name
            const peakIdx = s.scores.indexOf(Math.max(...s.scores))
            const cx      = xPos(peakIdx, dates.length)
            return (
              <text key={`label-${s.name}`}
                x={cx} y={PT + VH + 36}
                textAnchor="middle" fontSize="9" fill={dimmed ? '#cbd5e1' : color}
                fontWeight="600" style={{ pointerEvents: 'none' }}>
                {s.name.length > 14 ? s.name.slice(0, 13) + '…' : s.name}
              </text>
            )
          })}
        </svg>

        {/* Tooltip */}
        {hovered && <Tooltip bubble={hovered} />}
      </div>

      {/* Legend */}
      <div className="rdp-legend">
        {series.map((s, i) => {
          const color    = LINE_COLORS[i % LINE_COLORS.length]
          const inactive = focused && focused !== s.name
          return (
            <button key={s.name}
              className={`rdp-legend-item${inactive ? ' rdp-legend-item--dim' : ''}`}
              onClick={() => toggleFocus(s.name)}
              title="Click to isolate · Click again to reset"
            >
              <span className="rdp-legend-dot" style={{ background: color }} />
              {getAzureIconUrl(s.type, s.name) && <img src={getAzureIconUrl(s.type, s.name)} alt="" width="12" height="12" />}
              <span>{s.name}</span>
            </button>
          )
        })}
        {focused && <button className="rdp-legend-reset" onClick={() => setFocused(null)}>Show all</button>}
      </div>
    </div>
  )
}
