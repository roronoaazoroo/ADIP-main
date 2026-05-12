// FILE: src/components/RgDriftRiskMap.jsx
// ROLE: Bubble chart showing drift risk per resource in a resource group
import React, { useState, useEffect } from 'react'
import { fetchRgDriftRisk } from '../services/api'
import { getAzureIconUrl } from '../utils/azureIcons'

function riskColor(score) {
  if (score >= 70) return '#dc2626'
  if (score >= 40) return '#f59e0b'
  return '#10b981'
}

export default function RgDriftRiskMap({ subscriptionId, resourceGroup }) {
  const [resources, setResources] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!subscriptionId || !resourceGroup) return
    setLoading(true)
    setError(null)
    fetchRgDriftRisk(subscriptionId, resourceGroup)
      .then(data => setResources(data || []))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [subscriptionId, resourceGroup])

  if (loading) return <div style={{ padding: 30, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>Analyzing drift risk...</div>
  if (error) return <div style={{ padding: 16, color: '#dc2626', fontSize: 12 }}>Error: {error}</div>
  if (!resources.length) return <div style={{ padding: 30, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>No resources with change history in this resource group</div>

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <span style={{ fontSize: 14, fontWeight: 700 }}>Drift Risk Map</span>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>{resources.length} resources analyzed</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, fontSize: 10 }}>
          <span style={{ color: '#dc2626' }}>● High (&gt;70%)</span>
          <span style={{ color: '#f59e0b' }}>● Medium (40-70%)</span>
          <span style={{ color: '#10b981' }}>● Low (&lt;40%)</span>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'center', padding: 16 }}>
        {resources.map((r, i) => {
          const size = Math.max(80, Math.min(r.riskScore + 50, 140))
          const color = riskColor(r.riskScore)
          const iconUrl = getAzureIconUrl(r.resourceType)
          return (
            <div key={i} title={`${r.resourceName} (${r.resourceType || ''})
${r.factors?.join(', ') || ''}`} style={{
              width: size, height: size, borderRadius: '50%',
              background: `${color}10`, border: `3px solid ${color}`,
              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
              cursor: 'default',
            }}>
              {iconUrl ? (
                <img src={iconUrl} alt="" style={{ width: 22, height: 22, marginBottom: 2 }} />
              ) : (
                <span className="material-symbols-outlined" style={{ fontSize: 20, color: '#64748b', marginBottom: 2 }}>cloud</span>
              )}
              <div style={{ fontSize: 15, fontWeight: 800, color }}>{r.riskScore}%</div>
              <div style={{ fontSize: 8, color: '#374151', textAlign: 'center', padding: '0 6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: size - 12 }}>
                {r.resourceName}
              </div>
            </div>
          )
        })}
      </div>

      {/* Detail list below bubbles */}
      <div style={{ marginTop: 16, borderTop: '1px solid #e2e8f0', paddingTop: 12 }}>
        {resources.slice(0, 8).map((r, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #f1f5f9' }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: riskColor(r.riskScore) }} />
            <span style={{ fontSize: 12, fontWeight: 600, flex: 1 }}>{r.resourceName}</span>
            <span style={{ fontSize: 10, color: '#64748b' }}>{(r.resourceType || '').split('/').pop() || ''}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: riskColor(r.riskScore) }}>{r.riskScore}%</span>
            <span style={{ fontSize: 10, color: '#94a3b8', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.factors?.[0] || ''}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
