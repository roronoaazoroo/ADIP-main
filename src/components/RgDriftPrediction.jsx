// FILE: src/components/RgDriftPrediction.jsx
// ROLE: Resource-group level drift prediction panel.
//   - Bubble chart: X=drift frequency (7d), Y=severity score, size=total drifts
//   - Per-resource 14-day heatmap (one row per resource)
//   - AI prediction cards sorted by risk
//   All visuals are interactive: hover tooltips, click to highlight.

import { useEffect, useState, useCallback } from 'react'
import { fetchRgPrediction } from '../services/rgPredictionApi'
import { getAzureIconUrl, RESOURCE_GROUP_ICON_URL } from '../utils/azureIcons'
import './RgDriftPrediction.css'

const SEV_COLOR  = { critical: '#ef4444', high: '#f97316', medium: '#f59e0b', low: '#10b981' }
const SEV_SCORE  = { critical: 4, high: 3, medium: 2, low: 1 }
const LIKELIHOOD_COLOR = { HIGH: '#ef4444', MEDIUM: '#f59e0b', LOW: '#10b981' }

// ── Bubble Risk Matrix ────────────────────────────────────────────────────────
// X = drift frequency last 7 days, Y = severity score, bubble size = total drifts
function BubbleMatrix({ stats, selected, onSelect }) {
  const [tooltip, setTooltip] = useState(null)

  const drifted = stats.filter(s => s.total > 0)
  if (!drifted.length) return null

  const W = 560, H = 200, PAD = 40
  const maxX = Math.max(...drifted.map(s => s.last7d), 1)
  const maxY = Math.max(...drifted.map(s =>
    Object.entries(s.severities).reduce((acc, [sev, cnt]) => acc + (SEV_SCORE[sev] || 0) * cnt, 0)
  ), 1)
  const maxR = Math.max(...drifted.map(s => s.total), 1)

  return (
    <div style={{ position: 'relative' }}>
      <div className="rgp-section-title">Risk Matrix — Frequency vs Severity</div>
      <svg viewBox={`0 0 ${W + PAD * 2} ${H + PAD * 2}`} className="rgp-matrix-svg"
        onMouseLeave={() => setTooltip(null)}>

        {/* Grid */}
        {[0, 0.5, 1].map((p, i) => (
          <g key={i}>
            <line x1={PAD} y1={PAD + p * H} x2={PAD + W} y2={PAD + p * H} stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
            <line x1={PAD + p * W} y1={PAD} x2={PAD + p * W} y2={PAD + H} stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
          </g>
        ))}

        {/* Axis labels */}
        <text x={PAD + W / 2} y={PAD * 2 + H} textAnchor="middle" fontSize="10" fill="#475569">Drift Frequency (7d)</text>
        <text x={12} y={PAD + H / 2} textAnchor="middle" fontSize="10" fill="#475569"
          transform={`rotate(-90, 12, ${PAD + H / 2})`}>Severity Score</text>

        {/* Bubbles */}
        {drifted.map(s => {
          const sevScore = Object.entries(s.severities).reduce((acc, [sev, cnt]) => acc + (SEV_SCORE[sev] || 0) * cnt, 0)
          const cx = PAD + (s.last7d / maxX) * W
          const cy = PAD + H - (sevScore / maxY) * H
          const r  = 8 + (s.total / maxR) * 18
          const worstSev = ['critical','high','medium','low'].find(sv => s.severities[sv] > 0) || 'low'
          const isSelected = selected === s.name

          return (
            <g key={s.name}
              onMouseEnter={() => setTooltip({ s, cx, cy })}
              onMouseLeave={() => setTooltip(null)}
              onClick={() => onSelect(isSelected ? null : s.name)}
            >
              {/* Bubble ring coloured by severity */}
              <circle cx={cx} cy={cy} r={r}
                fill={SEV_COLOR[worstSev]} fillOpacity={isSelected ? 0.18 : 0.10}
                stroke={SEV_COLOR[worstSev]} strokeWidth={isSelected ? 2 : 1}
                className={`rgp-bubble${isSelected ? ' rgp-bubble--selected' : ''}`}
              />
              {/* Azure service icon centered in bubble */}
              {getAzureIconUrl(s.type, s.name) && (
                <image href={getAzureIconUrl(s.type, s.name)}
                  x={cx - 12} y={cy - 12} width="24" height="24"
                  style={{ pointerEvents: 'none' }}
                />
              )}
              <text x={cx} y={cy + r + 11} textAnchor="middle" fontSize="9" fill="#6b7280"
                style={{ pointerEvents: 'none' }}>
                {s.name.length > 12 ? s.name.slice(0, 11) + '…' : s.name}
              </text>
            </g>
          )
        })}

        {/* Tooltip */}
        {tooltip && (
          <foreignObject x={Math.min(tooltip.cx + 10, W)} y={Math.max(tooltip.cy - 60, PAD)} width="180" height="120">
            <div className="rgp-tooltip">
              <div className="rgp-tooltip-title">{tooltip.s.name}</div>
              <div className="rgp-tooltip-row"><span>Total drifts</span><strong>{tooltip.s.total}</strong></div>
              <div className="rgp-tooltip-row"><span>Last 24h</span><strong>{tooltip.s.last24h}</strong></div>
              <div className="rgp-tooltip-row"><span>Last 7d</span><strong>{tooltip.s.last7d}</strong></div>
              <div className="rgp-tooltip-row"><span>Critical</span><strong style={{ color: '#ef4444' }}>{tooltip.s.severities.critical}</strong></div>
            </div>
          </foreignObject>
        )}
      </svg>

      {/* Legend */}
      <div className="rgp-legend">
        {['critical','high','medium','low'].map(sev => (
          <span key={sev} className="rgp-legend-item">
            <span className="rgp-legend-dot" style={{ background: SEV_COLOR[sev] }} />{sev}
          </span>
        ))}
        <span style={{ fontSize: 11, color: '#475569', marginLeft: 'auto' }}>Ring size = drift count</span>
      </div>
    </div>
  )
}

// ── 14-day Heatmap (one row per drifted resource) ─────────────────────────────
function DriftHeatmap({ stats, selected, onSelect }) {
  const [tooltip, setTooltip] = useState(null)

  const drifted = stats.filter(s => s.total > 0)
  if (!drifted.length) return null

  // Build 14-day date keys
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.now() - (13 - i) * 86400000)
    return { key: d.toISOString().slice(0, 10), label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }
  })

  // Count drifts per resource per day
  const heatData = drifted.map(s => {
    const counts = {}
    s.driftDates.forEach(d => { counts[d] = (counts[d] || 0) + 1 })
    return { ...s, counts }
  })

  const maxCount = Math.max(...heatData.flatMap(s => Object.values(s.counts)), 1)

  return (
    <div>
      <div className="rgp-section-title">14-Day Drift Heatmap — Per Resource</div>
      <div className="rgp-heatmap">
        {heatData.map(s => (
          <div key={s.name} className="rgp-heatmap-row"
            onClick={() => onSelect(selected === s.name ? null : s.name)}
            style={{ opacity: selected && selected !== s.name ? 0.4 : 1, cursor: 'pointer' }}>
            <span className="rgp-heatmap-label" title={s.name} style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'flex-end' }}>
              {getAzureIconUrl(s.type, s.name) && <img src={getAzureIconUrl(s.type, s.name)} alt="" width="14" height="14" style={{ flexShrink: 0 }} />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</span>
            </span>
            <div className="rgp-heatmap-cells">
              {days.map(({ key, label }) => {
                const count = s.counts[key] || 0
                const intensity = count === 0 ? 0.06 : 0.2 + (count / maxCount) * 0.8
                const worstSev = ['critical','high','medium','low'].find(sv => s.severities[sv] > 0) || 'low'
                return (
                  <div key={key} className="rgp-heatmap-cell"
                    style={{ background: SEV_COLOR[worstSev], opacity: intensity }}
                    title={`${s.name} on ${label}: ${count} drift event${count !== 1 ? 's' : ''}`}
                    onMouseEnter={e => setTooltip({ s, date: label, count, rect: e.currentTarget.getBoundingClientRect() })}
                    onMouseLeave={() => setTooltip(null)}
                  />
                )
              })}
            </div>
          </div>
        ))}

        {/* Day labels — show every 3rd */}
        <div className="rgp-heatmap-day-labels">
          {days.map(({ label }, i) => (
            <span key={i} className="rgp-heatmap-day-label">{i % 3 === 0 ? label : ''}</span>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="rgp-legend" style={{ marginTop: 10 }}>
        <span style={{ fontSize: 11, color: '#475569' }}>Colour = worst severity · Intensity = frequency · Click row to highlight</span>
      </div>
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function RgDriftPrediction({ subscriptionId, resourceGroup }) {
  const [data,     setData]     = useState(null)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState(null)
  const [selected, setSelected] = useState(null)   // selected resource name

  useEffect(() => {
    if (!subscriptionId || !resourceGroup) return
    setLoading(true)
    setData(null)
    setError(null)
    fetchRgPrediction(subscriptionId, resourceGroup)
      .then(d => setData(d))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [subscriptionId, resourceGroup])

  const handleSelect = useCallback(name => setSelected(name), [])

  if (!subscriptionId || !resourceGroup) {
    return <div className="rgp-empty">Select a subscription and resource group on the Drift Scanner first.</div>
  }

  if (loading) return (
    <div className="rgp-loading"><div className="rgp-spinner" />Analysing resource group drift patterns…</div>
  )

  if (error) return <div className="rgp-empty" style={{ color: '#f87171' }}>⚠ {error}</div>
  if (!data)  return null

  const { resourceStats = [], aiPredictions = [], totalResources, totalDriftEvents } = data
  const driftedCount = resourceStats.filter(r => r.total > 0).length

  return (
    <div className="rgp-wrap">
      {/* Summary stats */}
      <div className="rgp-stats">
        <div className="rgp-stat">
          <div className="rgp-stat-value">{totalResources}</div>
          <div className="rgp-stat-label">Total Resources</div>
        </div>
        <div className="rgp-stat">
          <div className="rgp-stat-value" style={{ color: '#f97316' }}>{driftedCount}</div>
          <div className="rgp-stat-label">Resources Drifted</div>
        </div>
        <div className="rgp-stat">
          <div className="rgp-stat-value" style={{ color: '#ef4444' }}>{totalDriftEvents}</div>
          <div className="rgp-stat-label">Total Drift Events</div>
        </div>
        <div className="rgp-stat">
          <div className="rgp-stat-value" style={{ color: '#f59e0b' }}>
            {resourceStats.filter(r => r.last24h > 0).length}
          </div>
          <div className="rgp-stat-label">Active in Last 24h</div>
        </div>
      </div>

      {/* Bubble risk matrix */}
      <BubbleMatrix stats={resourceStats} selected={selected} onSelect={handleSelect} />

      {/* 14-day heatmap */}
      <DriftHeatmap stats={resourceStats} selected={selected} onSelect={handleSelect} />

      {/* AI Predictions */}
      {aiPredictions.length > 0 && (
        <div>
          <div className="rgp-section-title">AI Predictions — Next 7 Days</div>
          <div className="rgp-predictions">
            {aiPredictions.map((p, i) => {
              const stat = resourceStats.find(s => s.name === p.resourceName)
              return (
                <div key={i}
                  className={`rgp-pred-card rgp-pred-card--${p.likelihood}${selected === p.resourceName ? ' rgp-pred-card--selected' : ''}`}
                  onClick={() => handleSelect(selected === p.resourceName ? null : p.resourceName)}
                >
                  <div className="rgp-pred-top">
                    {stat?.type && getAzureIconUrl(stat.type, stat.name) && <img src={getAzureIconUrl(stat.type, stat.name)} alt="" width="18" height="18" style={{ flexShrink: 0 }} />}
                    <span className="rgp-pred-name">{p.resourceName}</span>
                    <span className="rgp-pred-type">{stat?.type?.split('/').pop()}</span>
                    <span className={`rgp-likelihood rgp-likelihood--${p.likelihood}`}>{p.likelihood}</span>
                  </div>
                  <p className="rgp-pred-reason">{p.reason}</p>
                  <div className="rgp-pred-meta">
                    <span className="rgp-pred-meta-item">
                      <span className="material-symbols-outlined">schedule</span>
                      Within {p.predictedDays} day{p.predictedDays !== 1 ? 's' : ''}
                    </span>
                    {stat && (
                      <>
                        <span className="rgp-pred-meta-item">
                          <span className="material-symbols-outlined">history</span>
                          {stat.total} total · {stat.last24h} in 24h · {stat.last7d} in 7d
                        </span>
                        <span className="rgp-pred-meta-item" style={{ color: '#ef4444' }}>
                          <span className="material-symbols-outlined">warning</span>
                          {stat.severities.critical} critical
                        </span>
                      </>
                    )}
                  </div>
                  {p.fieldsAtRisk?.length > 0 && (
                    <div className="rgp-fields">
                      {p.fieldsAtRisk.map((f, j) => <span key={j} className="rgp-field-tag">{f}</span>)}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {aiPredictions.length === 0 && driftedCount === 0 && (
        <div className="rgp-empty">No drift history found for resources in <strong>{resourceGroup}</strong>.</div>
      )}
    </div>
  )
}
