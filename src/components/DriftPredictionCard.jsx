// FILE: src/components/DriftPredictionCard.jsx
// ROLE: Displays AI drift prediction + 14-day drift frequency bar chart for a resource.

import { useEffect, useState } from 'react'
import { fetchDriftHistory } from '../services/driftPredictionApi'
import './DriftPredictionCard.css'

const LIKELIHOOD_COLOR = { HIGH: '#ef4444', MEDIUM: '#f59e0b', LOW: '#10b981' }
const LIKELIHOOD_PCT   = { HIGH: 82, MEDIUM: 55, LOW: 22 }
const SEV_COLOR = { critical: '#ef4444', high: '#f97316', medium: '#f59e0b', low: '#10b981', none: '#1e293b' }
const SEV_RANK  = { critical: 4, high: 3, medium: 2, low: 1, none: 0 }

// ── Drift Frequency Bar Chart ─────────────────────────────────────────────────
function DriftFrequencyChart({ subscriptionId, resourceId }) {
  const [bars, setBars]       = useState([])
  const [tooltip, setTooltip] = useState(null)   // { index, x, y }

  useEffect(() => {
    if (!subscriptionId || !resourceId) return
    fetchDriftHistory(subscriptionId, resourceId)
      .then(records => {
        // Build 14-day buckets
        const buckets = {}
        for (let i = 13; i >= 0; i--) {
          const d   = new Date(Date.now() - i * 86400000)
          const key = d.toISOString().slice(0, 10)
          buckets[key] = {
            date:     key,
            label:    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
            count:    0,
            severity: 'none',
            events:   [],
          }
        }
        ;(Array.isArray(records) ? records : []).forEach(r => {
          const day = r.detectedAt?.slice(0, 10)
          if (!buckets[day]) return
          buckets[day].count++
          buckets[day].events.push(r.severity)
          if (SEV_RANK[r.severity] > SEV_RANK[buckets[day].severity]) {
            buckets[day].severity = r.severity
          }
        })
        setBars(Object.values(buckets))
      })
      .catch(() => {})
  }, [subscriptionId, resourceId])

  if (!bars.length) return null

  const maxCount = Math.max(...bars.map(b => b.count), 1)
  const CHART_H  = 90   // px height of bar area
  const totalDrifts = bars.reduce((s, b) => s + b.count, 0)

  return (
    <div className="dpc-chart-section">
      <div className="dpc-chart-header">
        <span className="dpc-chart-title">Drift Frequency — Last 14 Days</span>
        <span className="dpc-chart-total">{totalDrifts} total event{totalDrifts !== 1 ? 's' : ''}</span>
      </div>

      {/* Y-axis + bars */}
      <div className="dpc-chart-outer">
        {/* Y-axis labels */}
        <div className="dpc-yaxis">
          {[maxCount, Math.ceil(maxCount / 2), 0].map((v, i) => (
            <span key={i} className="dpc-yaxis-label">{v}</span>
          ))}
        </div>

        {/* Bar area */}
        <div className="dpc-chart-inner" style={{ height: CHART_H + 24 }}>
          {/* Grid lines */}
          <div className="dpc-grid-lines" style={{ height: CHART_H }}>
            {[0, 0.5, 1].map((pct, i) => (
              <div key={i} className="dpc-grid-line" style={{ bottom: `${pct * 100}%` }} />
            ))}
          </div>

          {/* Bars */}
          <div className="dpc-bars" style={{ height: CHART_H }}>
            {bars.map((bar, i) => {
              const heightPct = bar.count > 0 ? Math.max((bar.count / maxCount) * 100, 6) : 0
              const color     = SEV_COLOR[bar.severity]
              const showLabel = i % 3 === 0 || i === bars.length - 1

              return (
                <div key={i} className="dpc-bar-col"
                  onMouseEnter={e => setTooltip({ i, bar, rect: e.currentTarget.getBoundingClientRect() })}
                  onMouseLeave={() => setTooltip(null)}
                >
                  <div className="dpc-bar-track" style={{ height: CHART_H }}>
                    {bar.count > 0 && (
                      <>
                        <div className="dpc-bar-fill"
                          style={{ height: `${heightPct}%`, background: color }}
                        />
                        <span className="dpc-bar-count-label">{bar.count}</span>
                      </>
                    )}
                  </div>
                  {showLabel && <span className="dpc-bar-xlabel">{bar.label}</span>}
                </div>
              )
            })}
          </div>

          {/* Tooltip */}
          {tooltip && (
            <div className="dpc-tooltip">
              <strong>{tooltip.bar.label}</strong>
              <span>{tooltip.bar.count} drift event{tooltip.bar.count !== 1 ? 's' : ''}</span>
              {tooltip.bar.count > 0 && (
                <span style={{ color: SEV_COLOR[tooltip.bar.severity] }}>
                  Worst: {tooltip.bar.severity}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Legend */}
      <div className="dpc-chart-legend">
        {[['critical','#ef4444'],['high','#f97316'],['medium','#f59e0b'],['low','#10b981']].map(([sev, color]) => (
          <span key={sev} className="dpc-legend-item">
            <span className="dpc-legend-dot" style={{ background: color }} />{sev}
          </span>
        ))}
      </div>
    </div>
  )
}

// ── Main Card ─────────────────────────────────────────────────────────────────
export default function DriftPredictionCard({ prediction, loading, error, resourceName, subscriptionId, resourceId }) {
  if (loading) {
    return (
      <div className="dpc-wrap">
        <div className="dpc-loading">
          <div className="dpc-spinner" />
          Analysing drift history with Azure OpenAI…
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="dpc-wrap">
        <div className="dpc-error">⚠ Prediction unavailable: {error}</div>
        {subscriptionId && resourceId && <DriftFrequencyChart subscriptionId={subscriptionId} resourceId={resourceId} />}
      </div>
    )
  }

  if (!prediction) return null

  const { likelihood = 'LOW', predictedDays, fieldsAtRisk = [], reasoning, basedOn } = prediction
  const color = LIKELIHOOD_COLOR[likelihood] || '#6b7280'
  const pct   = LIKELIHOOD_PCT[likelihood] || 20

  return (
    <div className="dpc-wrap">
      <div className="dpc-header">
        <span className="material-symbols-outlined" style={{ color, fontSize: 18 }}>psychology</span>
        <span className="dpc-title">Drift Prediction{resourceName ? ` — ${resourceName}` : ''}</span>
        <span className={`dpc-badge dpc-badge--${likelihood}`}>{likelihood} RISK</span>
      </div>

      <div className="dpc-body">
        {/* Probability ring */}
        <div className="dpc-ring-wrap">
          <div className="dpc-ring">
            <svg viewBox="0 0 36 36" width="72" height="72">
              <circle cx="18" cy="18" r="15.9" fill="none" stroke="currentColor" strokeWidth="2.5" opacity="0.08" />
              <circle cx="18" cy="18" r="15.9" fill="none" stroke={color} strokeWidth="3"
                strokeDasharray={`${pct} ${100 - pct}`} strokeDashoffset="25" strokeLinecap="round" />
            </svg>
            <span className="dpc-ring-label">{pct}%</span>
          </div>
          <span className="dpc-ring-sub">Probability</span>
        </div>

        <div className="dpc-details">
          {reasoning && <p className="dpc-reasoning">{reasoning}</p>}

          {fieldsAtRisk.length > 0 && (
            <div className="dpc-fields">
              {fieldsAtRisk.map((f, i) => (
                <span key={i} className="dpc-field-tag">{f}</span>
              ))}
            </div>
          )}

          <div className="dpc-meta">
            {predictedDays && (
              <span className="dpc-meta-item">
                <span className="material-symbols-outlined">schedule</span>
                Expected within {predictedDays} day{predictedDays !== 1 ? 's' : ''}
              </span>
            )}
            {basedOn && (
              <span className="dpc-meta-item">
                <span className="material-symbols-outlined">history</span>
                {basedOn}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 14-day drift frequency bar chart */}
      {subscriptionId && resourceId && (
        <DriftFrequencyChart subscriptionId={subscriptionId} resourceId={resourceId} />
      )}
    </div>
  )
}
