// FILE: src/components/GenomeCtoView.jsx
// ROLE: CTO executive view of genome configuration health
import React, { useState, useEffect } from 'react'
import { fetchGenomeCtoSummary } from '../services/api'

const RISK_COLOR = { critical: '#003359', high: '#0060a9', medium: '#1995ff', low: '#63b3ed' }

export default function GenomeCtoView({ subscriptionId, resourceId, resourceGroupId }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const id = resourceId || resourceGroupId
    if (!subscriptionId || !id) return
    setLoading(true)
    fetchGenomeCtoSummary(subscriptionId, id)
      .then(d => setData(d))
      .catch(() => setData(null))
      .finally(() => setLoading(false))
  }, [subscriptionId, resourceId, resourceGroupId])

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>Loading executive summary...</div>
  if (!data) return <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>No data available</div>

  const scoreColor = data.healthScore >= 80 ? '#1995ff' : data.healthScore >= 60 ? '#0060a9' : '#003359'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Health Score + AI Summary */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ textAlign: 'center', padding: 16, borderRadius: 12, border: '1px solid #e2e8f0', minWidth: 100 }}>
          <div style={{ fontSize: 36, fontWeight: 800, color: scoreColor }}>{data.healthScore}</div>
          <div style={{ fontSize: 10, color: '#64748b', marginTop: 4 }}>Health Score</div>
        </div>
        <div style={{ flex: 1, padding: 14, borderRadius: 8, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#475569', marginBottom: 6 }}>AI Executive Summary</div>
          <div style={{ fontSize: 13, color: '#1e293b', lineHeight: 1.5 }}>{data.summary || 'Summary unavailable'}</div>
        </div>
      </div>

      {/* Security Posture */}
      <div style={{ padding: 14, borderRadius: 8, border: '1px solid #e2e8f0' }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#475569', marginBottom: 8 }}>Security Posture</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {[
            { label: 'HTTPS', ok: data.latestConfig?.httpsOnly === true },
            { label: 'TLS 1.2', ok: data.latestConfig?.tls === 'TLS1_2' },
            { label: 'Public Access Blocked', ok: data.latestConfig?.publicAccess === false },
            { label: 'Network Deny Default', ok: data.latestConfig?.networkDefault === 'Deny' },
            { label: 'Managed Identity', ok: data.latestConfig?.identity !== 'None' },
          ].map((item, i) => (
            <span key={i} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 4, background: item.ok ? 'rgba(25,149,255,0.1)' : 'rgba(0,51,89,0.08)', color: item.ok ? '#1995ff' : '#003359', border: `1px solid ${item.ok ? 'rgba(25,149,255,0.3)' : 'rgba(0,51,89,0.2)'}` }}>
              {item.ok ? 'PASS' : 'FAIL'} {item.label}
            </span>
          ))}
        </div>
      </div>

      {/* Risks */}
      {data.risks?.length > 0 && (
        <div style={{ padding: 14, borderRadius: 8, border: '1px solid rgba(0,51,89,0.2)', background: 'rgba(0,51,89,0.04)' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#003359', marginBottom: 8 }}>Active Risks</div>
          {data.risks.map((r, i) => (
            <div key={i} style={{ fontSize: 12, color: RISK_COLOR[r.level] || '#64748b', marginBottom: 4 }}>
              • {r.message}
            </div>
          ))}
        </div>
      )}

      {/* Stability + Cost */}
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 1, padding: 14, borderRadius: 8, border: '1px solid #e2e8f0' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#475569', marginBottom: 6 }}>Stability</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#1e293b' }}>{data.stability?.changesPerDay || 0}</div>
          <div style={{ fontSize: 10, color: '#94a3b8' }}>changes/day ({data.stability?.totalChanges} total over {data.stability?.daySpan} days)</div>
        </div>
        <div style={{ flex: 1, padding: 14, borderRadius: 8, border: '1px solid #e2e8f0' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#475569', marginBottom: 6 }}>Current Cost</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: '#1e293b' }}>${((data.costTrend?.[0]?.costPerGB || 0) * 1024).toFixed(2)}</div>
          <div style={{ fontSize: 10, color: '#94a3b8' }}>/month (1TB reference, {data.latestConfig?.sku || 'unknown'} SKU)</div>
        </div>
      </div>
    </div>
  )
}
