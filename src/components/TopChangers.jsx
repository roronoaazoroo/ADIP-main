// ============================================================
// FILE: src/components/TopChangers.jsx
// ROLE: Shows the user with the highest change-to-drift ratio
//       as a widget on DashboardHome.
//
// "Change-to-drift ratio" = driftCount / totalChanges
// Higher ratio = more of their changes caused drift = higher risk
//
// Props: subscriptionId
// ============================================================
import React, { useState, useEffect } from 'react'
import { fetchChangeAttribution } from '../services/api'

const ENV_SUB_ID = import.meta.env.VITE_AZURE_SUBSCRIPTION_ID || ''

export default function TopChangers({ subscriptionId }) {
  const [rows,    setRows]    = useState([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)

  const effectiveSubId = subscriptionId || ENV_SUB_ID

  useEffect(() => {
    if (!effectiveSubId) return
    let cancelled = false
    setLoading(true)
    fetchChangeAttribution(effectiveSubId, 30)
      .then(data => {
        if (cancelled) return
        // Sort by drift ratio descending, take top 5
        const ranked = (data || [])
          .filter(r => r.totalChanges > 0)
          .map(r => ({ ...r, ratio: r.driftCount / r.totalChanges }))
          .sort((a, b) => b.ratio - a.ratio)
          .slice(0, 5)
        setRows(ranked)
      })
      .catch(err => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [effectiveSubId])

  if (loading) return <div className="dh-top-changers-empty" role="status"><div className="skeleton skeleton-text" style={{ width: '60%', height: 14 }} /></div>
  if (error)   return <div className="dh-top-changers-empty" role="alert" style={{ color: '#ef4444' }}>{error}</div>
  if (!rows.length) return <div className="dh-top-changers-empty" role="status">No attribution data available yet. Data appears after drift events are detected.</div>

  const top = rows[0]

  return (
    <div className="dh-top-changers">
      {/* Highlight card for #1 */}
      <div className="dh-top-changer-hero">
        <span className="material-symbols-outlined" style={{ fontSize: 32, color: '#f59e0b' }} aria-hidden="true">emoji_events</span>
        <div>
          <div className="dh-top-changer-name">{top.caller}</div>
          <div className="dh-top-changer-stat">
            {top.driftCount} drift{top.driftCount !== 1 ? 's' : ''} from {top.totalChanges} changes
            &nbsp;·&nbsp;
            <strong>{(top.ratio * 100).toFixed(1)}% drift rate</strong>
          </div>
        </div>
      </div>

      {/* Ranked list */}
      <table className="dh-table" style={{ marginTop: 12 }} aria-label="Top drift causers">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Identity</th>
            <th scope="col">Changes</th>
            <th scope="col">Drifts</th>
            <th scope="col">Drift Rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="dh-tr">
              <td style={{ color: '#64748b' }}>{i + 1}</td>
              <td>{row.caller}</td>
              <td>{row.totalChanges}</td>
              <td>{row.driftCount}</td>
              <td style={{ color: row.ratio > 0.05 ? '#ef4444' : row.ratio > 0 ? '#f59e0b' : '#10b981', fontWeight: 600 }}>
                {(row.ratio * 100).toFixed(1)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
