// ============================================================
// FILE: src/components/ArmInfrastructureSummary.jsx
// ROLE: AI Infrastructure Summary — CTO-only section on ComparisonPage
// ============================================================
import React, { useState, useEffect } from 'react'

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api'

export default function ArmInfrastructureSummary({ subscriptionId, resourceGroupId, baselineState, liveState, differences }) {
  const [analysis, setAnalysis] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!baselineState && !liveState) return
    setLoading(true)
    const token = sessionStorage.getItem('adip.token')
    fetch(`${API_BASE}/arm-analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ subscriptionId, resourceGroupId, baselineState, liveState, differences }),
    })
      .then(r => r.json())
      .then(data => { if (!data.error) setAnalysis(data) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [subscriptionId, resourceGroupId, baselineState?.resources?.length, liveState?.resources?.length])

  if (loading) return <div className="cp-card" style={{ marginTop: 16, padding: 20 }}><span style={{ color: '#60a5fa', fontSize: 13 }}>⏳ AI analyzing infrastructure changes...</span></div>
  if (!analysis) return null

  const riskColor = { critical: '#ef4444', high: '#f97316', medium: '#f59e0b', low: '#10b981' }

  return (
    <div className="cp-card" style={{ marginTop: 16 }}>
      <div className="cp-card-header">
        <span className="material-symbols-outlined" style={{ color: '#0060a9' }}>architecture</span>
        <h3>AI Infrastructure Summary</h3>
      </div>
      <div style={{ padding: '16px 20px', fontSize: 13, lineHeight: 1.8 }}>
        {/* Summary */}
        {analysis.summary && <p style={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: 12 }}>{analysis.summary}</p>}

        {/* New Resources */}
        {analysis.newResources?.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#10b981', marginBottom: 6 }}>New Resources Created</div>
            {analysis.newResources.map((r, i) => (
              <div key={i} style={{ padding: '6px 10px', marginBottom: 4, background: 'rgba(16,185,129,0.06)', borderRadius: 6, border: '1px solid rgba(16,185,129,0.15)' }}>
                <span style={{ fontWeight: 600 }}>{r.name}</span> <span style={{ color: 'rgba(255,255,255,0.4)' }}>({r.type})</span>
                {r.description && <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>{r.description}</div>}
              </div>
            ))}
          </div>
        )}

        {/* Deleted Resources */}
        {analysis.deletedResources?.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#ef4444', marginBottom: 6 }}>Deleted Resources</div>
            {analysis.deletedResources.map((r, i) => (
              <div key={i} style={{ padding: '6px 10px', marginBottom: 4, background: 'rgba(239,68,68,0.06)', borderRadius: 6, border: '1px solid rgba(239,68,68,0.15)' }}>
                <span style={{ fontWeight: 600 }}>{r.name}</span> <span style={{ color: 'rgba(255,255,255,0.4)' }}>({r.type})</span>
                {r.description && <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>{r.description}</div>}
              </div>
            ))}
          </div>
        )}

        {/* Modified Resources */}
        {analysis.modifiedResources?.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#f59e0b', marginBottom: 6 }}>Configuration Changes</div>
            {analysis.modifiedResources.map((r, i) => (
              <div key={i} style={{ padding: '6px 10px', marginBottom: 4, background: 'rgba(245,158,11,0.06)', borderRadius: 6, border: '1px solid rgba(245,158,11,0.15)' }}>
                <span style={{ fontWeight: 600 }}>{r.field || r.name}</span>
                {r.from && r.to && <span style={{ color: 'rgba(255,255,255,0.4)' }}> — {r.from} → {r.to}</span>}
                {r.impact && <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginTop: 2 }}>{r.impact}</div>}
              </div>
            ))}
          </div>
        )}

        {/* Risks */}
        {analysis.risks?.length > 0 && (
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#ef4444', marginBottom: 6 }}>Risk Assessment</div>
            {analysis.risks.map((r, i) => (
              <div key={i} style={{ padding: '6px 10px', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 3, background: `${riskColor[r.level] || '#64748b'}18`, color: riskColor[r.level] || '#64748b', textTransform: 'uppercase' }}>{r.level}</span>
                <span style={{ color: 'var(--text-secondary)' }}>{r.description}</span>
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!analysis.newResources?.length && !analysis.deletedResources?.length && !analysis.modifiedResources?.length && (
          <p style={{ color: '#10b981' }}> No significant infrastructure changes detected.</p>
        )}
      </div>
    </div>
  )
}
