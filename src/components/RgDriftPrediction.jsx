// FILE: src/components/RgDriftPrediction.jsx
// ROLE: Resource-group level drift prediction panel.
//   - Summary KPI row
//   - Resource risk table with severity bars
//   - 14-day drift heatmap
//   - AI prediction cards

import { useEffect, useState, useCallback } from 'react'
import { fetchRgPrediction } from '../services/rgPredictionApi'
import { getAzureIconUrl } from '../utils/azureIcons'
import './RgDriftPrediction.css'

const SEV_COLOR = { critical: '#ef4444', high: '#f97316', medium: '#f59e0b', low: '#10b981' }
const SEV_SCORE = { critical: 4, high: 3, medium: 2, low: 1 }
const LIKELIHOOD_COLOR = { HIGH: '#ef4444', MEDIUM: '#f59e0b', LOW: '#10b981' }

//  Severity mini-bar 
function SeverityBar({ severities }) {
  const total = Object.values(severities).reduce((s, v) => s + v, 0)
  if (!total) return <span className="rgp-no-drift">—</span>
  return (
    <div className="rgp-sev-bar">
      {['critical', 'high', 'medium', 'low'].map(sev => {
        const pct = (severities[sev] / total) * 100
        if (!pct) return null
        return <div key={sev} className="rgp-sev-bar-seg" style={{ width: `${pct}%`, background: SEV_COLOR[sev] }} title={`${sev}: ${severities[sev]}`} />
      })}
    </div>
  )
}

//  Risk score for a resource 
function riskScore(stat) {
  return Object.entries(stat.severities).reduce((acc, [sev, cnt]) => acc + (SEV_SCORE[sev] || 0) * cnt, 0)
}

//  Main Component 
export default function RgDriftPrediction({ subscriptionId, resourceGroup }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)
  const [heatmapExpanded, setHeatmapExpanded] = useState(false)

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

  const handleSelect = useCallback(name => setSelected(prev => prev === name ? null : name), [])

  if (!subscriptionId || !resourceGroup) {
    return <div className="rgp-empty">Select a subscription and resource group on the Drift Scanner first.</div>
  }

  if (loading) return (
    <div className="rgp-loading"><div className="rgp-spinner" />Loading predictions…</div>
  )
  if (error) return <div className="rgp-empty" style={{ color: '#ef4444' }}>⚠ {error}</div>
  if (!data) return null

  const { resourceStats = [], aiPredictions = [], totalResources, totalDriftEvents } = data
  const driftedResources = resourceStats.filter(r => r.total > 0).sort((a, b) => riskScore(b) - riskScore(a))
  const driftedCount = driftedResources.length
  const criticalCount = resourceStats.reduce((s, r) => s + (r.severities?.critical || 0), 0)
  const activeIn24h = resourceStats.filter(r => r.last24h > 0).length

  // 14-day heatmap data
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.now() - (13 - i) * 86400000)
    return { key: d.toISOString().slice(0, 10), label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) }
  })

  const heatRows = driftedResources.map(s => {
    const counts = {}
    ;(s.driftDates || []).forEach(d => { counts[d] = (counts[d] || 0) + 1 })
    return { ...s, counts }
  })
  const maxHeatCount = Math.max(...heatRows.flatMap(s => Object.values(s.counts)), 1)
  const visibleHeatRows = heatmapExpanded ? heatRows : heatRows.slice(0, 6)

  return (
    <div className="rgp-root">

      {/*  KPI Summary  */}
      <div className="rgp-kpis">
        <div className="rgp-kpi">
          <div className="rgp-kpi-val">{totalResources}</div>
          <div className="rgp-kpi-label">Resources</div>
        </div>
        <div className="rgp-kpi">
          <div className="rgp-kpi-val" style={{ color: driftedCount > 0 ? '#f97316' : undefined }}>{driftedCount}</div>
          <div className="rgp-kpi-label">Drifted</div>
        </div>
        <div className="rgp-kpi">
          <div className="rgp-kpi-val" style={{ color: totalDriftEvents > 0 ? '#ef4444' : undefined }}>{totalDriftEvents}</div>
          <div className="rgp-kpi-label">Total Events</div>
        </div>
        <div className="rgp-kpi">
          <div className="rgp-kpi-val" style={{ color: criticalCount > 0 ? '#ef4444' : undefined }}>{criticalCount}</div>
          <div className="rgp-kpi-label">Critical</div>
        </div>
        <div className="rgp-kpi">
          <div className="rgp-kpi-val">{activeIn24h}</div>
          <div className="rgp-kpi-label">Active 24h</div>
        </div>
      </div>

      {/*  Two-column layout  */}
      <div className="rgp-columns">

        {/* Left — Resource Risk Table */}
        <div className="rgp-panel">
          <div className="rgp-panel-head">
            <h3 className="rgp-panel-title">Resource Risk</h3>
            <span className="rgp-panel-count">{driftedCount} of {totalResources}</span>
          </div>

          {driftedCount === 0 ? (
            <div className="rgp-panel-empty">No drifted resources found.</div>
          ) : (
            <div className="rgp-risk-table">
              <div className="rgp-risk-header">
                <span className="rgp-risk-th rgp-risk-th--name">Resource</span>
                <span className="rgp-risk-th rgp-risk-th--count">Events</span>
                <span className="rgp-risk-th rgp-risk-th--sev">Severity</span>
                <span className="rgp-risk-th rgp-risk-th--recent">24h</span>
              </div>
              {driftedResources.map(s => {
                const isActive = selected === s.name
                const iconUrl = getAzureIconUrl(s.type, s.name)
                return (
                  <div key={s.name}
                    className={`rgp-risk-row${isActive ? ' rgp-risk-row--active' : ''}`}
                    onClick={() => handleSelect(s.name)}
                  >
                    <div className="rgp-risk-cell rgp-risk-cell--name">
                      {iconUrl && <img src={iconUrl} alt="" width="16" height="16" className="rgp-risk-icon" />}
                      <span className="rgp-risk-name" title={s.name}>
                        {s.name.length > 24 ? s.name.slice(0, 22) + '…' : s.name}
                      </span>
                      <span className="rgp-risk-type">{(s.type || '').split('/').pop()}</span>
                    </div>
                    <div className="rgp-risk-cell rgp-risk-cell--count">
                      <span className="rgp-risk-count">{s.total}</span>
                    </div>
                    <div className="rgp-risk-cell rgp-risk-cell--sev">
                      <SeverityBar severities={s.severities} />
                    </div>
                    <div className="rgp-risk-cell rgp-risk-cell--recent">
                      {s.last24h > 0 ? (
                        <span className="rgp-risk-recent-dot" />
                      ) : (
                        <span style={{ color: '#cbd5e1' }}>—</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Right — AI Predictions */}
        <div className="rgp-panel">
          <div className="rgp-panel-head">
            <h3 className="rgp-panel-title">Predictions</h3>
            <span className="rgp-panel-tag">Next 7 days</span>
          </div>

          {aiPredictions.length === 0 ? (
            <div className="rgp-panel-empty">
              {driftedCount === 0
                ? 'No drift history — predictions will appear once drift is detected.'
                : 'No high-risk predictions for the next 7 days.'
              }
            </div>
          ) : (
            <div className="rgp-preds">
              {aiPredictions.map((p, i) => {
                const stat = resourceStats.find(s => s.name === p.resourceName)
                const iconUrl = stat?.type ? getAzureIconUrl(stat.type, stat.name) : null
                const isActive = selected === p.resourceName
                return (
                  <div key={i}
                    className={`rgp-pred${isActive ? ' rgp-pred--active' : ''}`}
                    onClick={() => handleSelect(p.resourceName)}
                  >
                    <div className="rgp-pred-head">
                      <div className="rgp-pred-resource">
                        {iconUrl && <img src={iconUrl} alt="" width="16" height="16" />}
                        <span className="rgp-pred-name">{p.resourceName}</span>
                      </div>
                      <span className={`rgp-pred-badge rgp-pred-badge--${(p.likelihood || '').toLowerCase()}`}>
                        {p.likelihood}
                      </span>
                    </div>

                    <p className="rgp-pred-reason">{p.reason}</p>

                    <div className="rgp-pred-foot">
                      <span className="rgp-pred-time">
                        <span className="material-symbols-outlined">schedule</span>
                        {p.predictedDays}d
                      </span>
                      {stat && (
                        <span className="rgp-pred-stat">
                          {stat.total} events · {stat.severities?.critical || 0} crit
                        </span>
                      )}
                    </div>

                    {p.fieldsAtRisk?.length > 0 && (
                      <div className="rgp-pred-fields">
                        {p.fieldsAtRisk.slice(0, 4).map((f, j) => (
                          <span key={j} className="rgp-pred-field">{f}</span>
                        ))}
                        {p.fieldsAtRisk.length > 4 && (
                          <span className="rgp-pred-field rgp-pred-field--more">+{p.fieldsAtRisk.length - 4}</span>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/*  Heatmap  */}
      {driftedCount > 0 && (
        <div className="rgp-panel rgp-panel--full">
          <div className="rgp-panel-head">
            <h3 className="rgp-panel-title">14-Day Activity</h3>
            {heatRows.length > 6 && (
              <button className="rgp-expand-btn" onClick={() => setHeatmapExpanded(p => !p)}>
                {heatmapExpanded ? 'Collapse' : `Show all ${heatRows.length}`}
              </button>
            )}
          </div>
          <div className="rgp-heatmap">
            {visibleHeatRows.map(s => {
              const isActive = selected === s.name
              const worstSev = ['critical', 'high', 'medium', 'low'].find(sv => s.severities[sv] > 0) || 'low'
              return (
                <div key={s.name}
                  className={`rgp-heat-row${isActive ? ' rgp-heat-row--active' : ''}${selected && !isActive ? ' rgp-heat-row--dim' : ''}`}
                  onClick={() => handleSelect(s.name)}
                >
                  <span className="rgp-heat-label" title={s.name}>{s.name.length > 14 ? s.name.slice(0, 12) + '…' : s.name}</span>
                  <div className="rgp-heat-cells">
                    {days.map(({ key }) => {
                      const count = s.counts[key] || 0
                      const opacity = count === 0 ? 0.07 : 0.25 + (count / maxHeatCount) * 0.75
                      return (
                        <div key={key} className="rgp-heat-cell"
                          style={{ background: SEV_COLOR[worstSev], opacity }}
                          title={`${count} event${count !== 1 ? 's' : ''}`}
                        />
                      )
                    })}
                  </div>
                  <span className="rgp-heat-total">{s.total}</span>
                </div>
              )
            })}
            {/* Date labels */}
            <div className="rgp-heat-dates">
              {days.map(({ label }, i) => (
                <span key={i} className="rgp-heat-date">{i % 3 === 0 ? label : ''}</span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
