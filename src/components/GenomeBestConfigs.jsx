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
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!subscriptionId || !resourceId) return
    setLoading(true)
    setError(null)
    fetchBestConfigs(subscriptionId, resourceId)
      .then(data => setRecommendations(data || []))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [subscriptionId, resourceId])

  return (
    <div>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>🏆</span> AI Recommended Best Configurations
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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

              </div>
            )
          })}
          {!loading && !error && !recommendations.length && (
            <div style={{ padding: 16, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>Not enough snapshots to analyze</div>
          )}
      </div>
    </div>
  )
}
