// ============================================================
// FILE: src/components/AggregatedDriftView.jsx
// ROLE: Shows net cumulative drift + intent-based AI recommendations
//       with checkboxes to selectively revert or keep changes
// ============================================================
import React, { useState, useEffect } from 'react'
import { fetchRecommendations, createTicket } from '../services/api'

const INTENT_OPTIONS = [
  { key: 'security', label: '🔒 Security', color: '#ef4444' },
  { key: 'cost', label: '💰 Cost', color: '#f59e0b' },
  { key: 'compliance', label: '📋 Compliance', color: '#0060a9' },
]

const PRIORITY_COLOR = { critical: '#ef4444', high: '#f97316', medium: '#f59e0b', keep: '#10b981' }

export default function AggregatedDriftView({ subscriptionId, resourceGroupId, resourceId, resourceType, fieldDifferences }) {
  const [intent, setIntent] = useState('security')
  const [recommendations, setRecommendations] = useState([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState(new Set())
  const [applyingTickets, setApplyingTickets] = useState(false)
  const [feedback, setFeedback] = useState(null)

  useEffect(() => {
    if (!fieldDifferences?.length) { setRecommendations([]); return }
    setLoading(true)
    setSelected(new Set())
    fetchRecommendations({ subscriptionId, resourceGroupId, resourceId, resourceType, intent, differences: fieldDifferences })
      .then(result => setRecommendations(result || []))
      .catch(() => setRecommendations([]))
      .finally(() => setLoading(false))
  }, [intent, subscriptionId, resourceId, fieldDifferences?.length])

  const toggleSelection = (index) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(index) ? next.delete(index) : next.add(index)
      return next
    })
  }

  const handleApplySelected = async () => {
    const toRevert = [...selected].map(i => recommendations[i]).filter(r => r.action === 'revert')
    if (!toRevert.length) { setFeedback('No revert items selected'); return }
    setApplyingTickets(true)
    try {
      const description = toRevert.map(r => `Revert ${r.field}: ${r.reason}`).join('; ')
      await createTicket({ subscriptionId, resourceGroupId, resourceId, severity: toRevert[0]?.priority || 'medium', description })
      setFeedback(`Remediation ticket created for ${toRevert.length} change${toRevert.length > 1 ? 's' : ''}`)
    } catch (error) {
      setFeedback(`Error: ${error.message}`)
    } finally {
      setApplyingTickets(false)
    }
  }

  if (!fieldDifferences?.length) {
    return <div style={{ padding: 16, color: '#10b981', fontSize: 14 }}>✓ No net drift — resource is in sync with baseline.</div>
  }

  return (
    <div style={{ padding: 16 }}>
      {/* Intent selector */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {INTENT_OPTIONS.map(option => (
          <button key={option.key} onClick={() => setIntent(option.key)}
            style={{
              padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600,
              background: intent === option.key ? `${option.color}20` : 'rgba(255,255,255,0.04)',
              color: intent === option.key ? option.color : 'rgba(255,255,255,0.5)',
              border: `1px solid ${intent === option.key ? option.color + '40' : 'rgba(255,255,255,0.08)'}`,
            }}>
            {option.label}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading && <div style={{ color: '#60a5fa', fontSize: 13, padding: '12px 0' }}>⏳ Generating AI recommendations...</div>}

      {/* Recommendations */}
      {!loading && recommendations.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {recommendations.map((recommendation, index) => (
            <div key={index} style={{
              padding: '12px 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)',
              background: selected.has(index) ? 'rgba(0,96,169,0.08)' : 'rgba(255,255,255,0.02)',
              cursor: 'pointer',
            }} onClick={() => toggleSelection(index)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input type="checkbox" checked={selected.has(index)} onChange={() => toggleSelection(index)}
                  style={{ accentColor: '#0060a9', width: 16, height: 16 }} />
                <span style={{
                  fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 3, textTransform: 'uppercase',
                  background: `${PRIORITY_COLOR[recommendation.priority] || '#64748b'}18`,
                  color: PRIORITY_COLOR[recommendation.priority] || '#64748b',
                }}>{recommendation.priority}</span>
                <span style={{ fontSize: 13, color: 'var(--text-primary)', flex: 1 }}>
                  <strong>{recommendation.action === 'keep' ? 'Keep' : 'Revert'}</strong> {recommendation.field}
                </span>
              </div>
              <div style={{ marginTop: 6, paddingLeft: 36, fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
                {recommendation.reason}
              </div>
              {recommendation.manualGuide && (
                <div style={{ marginTop: 8, paddingLeft: 36, fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>
                  <div><strong>Portal:</strong> {recommendation.manualGuide.portal}</div>
                  {recommendation.manualGuide.cli && <div><strong>CLI:</strong> <code>{recommendation.manualGuide.cli}</code></div>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      {!loading && recommendations.length > 0 && (
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button onClick={handleApplySelected} disabled={!selected.size || applyingTickets}
            style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: '#0060a9', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', opacity: !selected.size ? 0.4 : 1 }}>
            {applyingTickets ? 'Creating ticket...' : `Apply Selected (${selected.size})`}
          </button>
        </div>
      )}

      {/* Feedback */}
      {feedback && (
        <div style={{ marginTop: 12, padding: '8px 12px', borderRadius: 6, fontSize: 12, background: feedback.startsWith('Error') ? 'rgba(239,68,68,0.1)' : 'rgba(16,185,129,0.1)', color: feedback.startsWith('Error') ? '#ef4444' : '#10b981' }}>
          {feedback}
        </div>
      )}
    </div>
  )
}
