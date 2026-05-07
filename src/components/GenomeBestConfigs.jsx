// FILE: src/components/GenomeBestConfigs.jsx
// ROLE: AI-recommended best configurations from genome history
import React, { useState, useEffect } from 'react'
import { fetchBestConfigs } from '../services/api'

const CATEGORY_META = {
  cost_optimized: { icon: '💰', label: 'Most Cost Optimized', color: '#f59e0b' },
  most_secure: { icon: '🔒', label: 'Most Secure', color: '#10b981' },
  best_networking: { icon: '🌐', label: 'Best Networking', color: '#1995ff' },
}

export default function GenomeBestConfigs({ subscriptionId, resourceId, onViewConfig, onRollback }) {
  const [recommendations, setRecommendations] = useState([])
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!expanded || !subscriptionId || !resourceId) return
    if (recommendations.length) return
    setLoading(true)
    setError(null)
    fetchBestConfigs(subscriptionId, resourceId)
      .then(data => setRecommendations(data || []))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [expanded, subscriptionId, resourceId])

  return (
    <div style={{ marginBottom: 16 }}>
      <button onClick={() => setExpanded(!expanded)} style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        padding: '10px 14px', border: '1px solid #e2e8f0', borderRadius: 8,
        background: expanded ? '#f0f9ff' : '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600,
      }}>
        <span>🏆</span>
        <span>AI Recommended Best Configurations</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#64748b' }}>{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {loading && <div style={{ padding: 20, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>Analyzing configurations with AI...</div>}
          {error && <div style={{ padding: 12, color: '#dc2626', fontSize: 12 }}>Error: {error}</div>}
          {!loading && !error && recommendations.map((rec, i) => {
            const meta = CATEGORY_META[rec.category] || CATEGORY_META.cost_optimized
            return (
              <div key={i} style={{ padding: 12, border: `1px solid ${meta.color}30`, borderRadius: 8, background: `${meta.color}08` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span>{meta.icon}</span>
                  <strong style={{ fontSize: 12, color: meta.color }}>{meta.label}</strong>
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: '#94a3b8' }}>
                    {rec.savedAt ? new Date(rec.savedAt).toLocaleString() : ''}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: '#374151', marginBottom: 8 }}>{rec.reason}</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {rec.config && (
                    <span style={{ fontSize: 10, color: '#64748b' }}>
                      SKU: {rec.config.sku || '—'} | Tier: {rec.config.tier || '—'} | HTTPS: {String(rec.config.supportsHttpsTrafficOnly)} | Network: {rec.config.networkAcls_defaultAction || '—'}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  {rec.blobKey && onViewConfig && (
                    <button onClick={() => onViewConfig(rec.blobKey)} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 4, border: '1px solid #e2e8f0', background: '#fff', cursor: 'pointer' }}>
                      View Config
                    </button>
                  )}
                  {rec.blobKey && onRollback && (
                    <button onClick={() => onRollback(rec.blobKey)} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 4, border: '1px solid #dc262640', background: '#fef2f2', color: '#dc2626', cursor: 'pointer' }}>
                      Rollback to This
                    </button>
                  )}
                </div>
              </div>
            )
          })}
          {!loading && !error && !recommendations.length && (
            <div style={{ padding: 16, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>Not enough snapshots to analyze</div>
          )}
        </div>
      )}
    </div>
  )
}
