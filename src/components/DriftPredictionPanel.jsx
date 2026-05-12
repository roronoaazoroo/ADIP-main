// FILE: src/components/DriftPredictionPanel.jsx
// ROLE: ML-powered drift prediction UI for Analytics Prediction tab
import React, { useState, useEffect } from 'react'
import { fetchRgDriftRisk } from '../services/api'
import { getAzureIconUrl } from '../utils/azureIcons'

function riskColor(score) {
  if (score >= 70) return '#dc2626'
  if (score >= 40) return '#f59e0b'
  return '#10b981'
}

function riskLabel(score) {
  if (score >= 70) return 'High Risk'
  if (score >= 40) return 'Medium Risk'
  return 'Low Risk'
}

export default function DriftPredictionPanel({ subscriptionId, resourceGroup }) {
  const [resources, setResources] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [selectedResource, setSelectedResource] = useState(null)

  useEffect(() => {
    if (!subscriptionId) return
    setLoading(true)
    fetchRgDriftRisk(subscriptionId, resourceGroup || '')
      .then(data => setResources(data || []))
      .catch(err => { setError(err.message); setResources([]) })
      .finally(() => setLoading(false))
  }, [subscriptionId, resourceGroup])

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>Analyzing drift risk with ML model...</div>
  if (error) return <div style={{ padding: 20, color: '#dc2626', fontSize: 12 }}>Error: {error}</div>

  const highRisk = resources.filter(r => r.riskScore >= 70)
  const mediumRisk = resources.filter(r => r.riskScore >= 40 && r.riskScore < 70)
  const lowRisk = resources.filter(r => r.riskScore < 40)

  return (
    <div style={{ display: 'flex', gap: 16 }}>
      {/* Left: Risk Overview */}
      <div style={{ flex: 2, minWidth: 0 }}>
        {/* Summary Cards */}
        <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
          <div style={{ flex: 1, padding: 16, borderRadius: 10, background: '#fef2f2', border: '1px solid #fecaca', textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: '#dc2626' }}>{highRisk.length}</div>
            <div style={{ fontSize: 11, color: '#991b1b' }}>High Risk</div>
          </div>
          <div style={{ flex: 1, padding: 16, borderRadius: 10, background: '#fffbeb', border: '1px solid #fde68a', textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: '#f59e0b' }}>{mediumRisk.length}</div>
            <div style={{ fontSize: 11, color: '#92400e' }}>Medium Risk</div>
          </div>
          <div style={{ flex: 1, padding: 16, borderRadius: 10, background: '#f0fdf4', border: '1px solid #bbf7d0', textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: '#10b981' }}>{lowRisk.length}</div>
            <div style={{ fontSize: 11, color: '#065f46' }}>Low Risk</div>
          </div>
          <div style={{ flex: 1, padding: 16, borderRadius: 10, background: '#f8fafc', border: '1px solid #e2e8f0', textAlign: 'center' }}>
            <div style={{ fontSize: 28, fontWeight: 800, color: '#475569' }}>{resources.length}</div>
            <div style={{ fontSize: 11, color: '#64748b' }}>Total Analyzed</div>
          </div>
        </div>

        {/* Resource List */}
        <div style={{ borderRadius: 10, border: '1px solid #e2e8f0', overflow: 'hidden' }}>
          <div style={{ padding: '10px 16px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', fontSize: 12, fontWeight: 600, color: '#475569' }}>
            Resources Ranked by Drift Likelihood
          </div>
          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
            {resources.map((r, i) => {
              const color = riskColor(r.riskScore)
              const iconUrl = getAzureIconUrl(r.resourceType)
              const isSelected = selectedResource?.resourceId === r.resourceId
              return (
                <div key={i} onClick={() => setSelectedResource(isSelected ? null : r)}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid #f1f5f9', cursor: 'pointer', background: isSelected ? '#f0f9ff' : undefined }}>
                  <div style={{ width: 28, height: 28, borderRadius: '50%', background: `${color}15`, border: `2px solid ${color}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    {iconUrl ? <img src={iconUrl} alt="" style={{ width: 14, height: 14 }} /> : <span style={{ fontSize: 12, color }}>{r.riskScore}</span>}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.resourceName}</div>
                    <div style={{ fontSize: 10, color: '#94a3b8' }}>{(r.resourceType || '').split('/').pop()}</div>
                  </div>
                  {/* Progress bar */}
                  <div style={{ width: 80, height: 6, background: '#f1f5f9', borderRadius: 3, overflow: 'hidden', flexShrink: 0 }}>
                    <div style={{ width: `${r.riskScore}%`, height: '100%', background: color, borderRadius: 3 }} />
                  </div>
                  <div style={{ width: 40, textAlign: 'right', fontSize: 13, fontWeight: 700, color }}>{r.riskScore}%</div>
                </div>
              )
            })}
            {resources.length === 0 && (
              <div style={{ padding: 30, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>No resources with change history found</div>
            )}
          </div>
        </div>
      </div>

      {/* Right: Selected Resource Detail */}
      <div style={{ flex: 1, minWidth: 250 }}>
        {selectedResource ? (
          <div style={{ padding: 16, borderRadius: 10, border: '1px solid #e2e8f0', background: '#fff' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              {getAzureIconUrl(selectedResource.resourceType) && (
                <img src={getAzureIconUrl(selectedResource.resourceType)} alt="" style={{ width: 24, height: 24 }} />
              )}
              <div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{selectedResource.resourceName}</div>
                <div style={{ fontSize: 10, color: '#94a3b8' }}>{(selectedResource.resourceType || '').split('/').pop()}</div>
              </div>
            </div>

            {/* Score gauge */}
            <div style={{ textAlign: 'center', padding: '16px 0', marginBottom: 12, borderRadius: 8, background: `${riskColor(selectedResource.riskScore)}08`, border: `1px solid ${riskColor(selectedResource.riskScore)}30` }}>
              <div style={{ fontSize: 36, fontWeight: 800, color: riskColor(selectedResource.riskScore) }}>{selectedResource.riskScore}%</div>
              <div style={{ fontSize: 11, color: riskColor(selectedResource.riskScore), fontWeight: 600 }}>{riskLabel(selectedResource.riskScore)}</div>
            </div>

            {/* Stats */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                <span style={{ color: '#64748b' }}>Total Changes (30d)</span>
                <span style={{ fontWeight: 600 }}>{selectedResource.totalChanges || 0}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                <span style={{ color: '#64748b' }}>Drift Events</span>
                <span style={{ fontWeight: 600 }}>{selectedResource.driftCount || 0}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
                <span style={{ color: '#64748b' }}>Drift Ratio</span>
                <span style={{ fontWeight: 600 }}>{selectedResource.totalChanges ? Math.round((selectedResource.driftCount / selectedResource.totalChanges) * 100) : 0}%</span>
              </div>
            </div>

            {/* Risk Factors */}
            {selectedResource.factors?.length > 0 && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #f1f5f9' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#475569', marginBottom: 6 }}>Risk Factors</div>
                {selectedResource.factors.map((f, i) => (
                  <div key={i} style={{ fontSize: 11, color: '#64748b', padding: '3px 0', display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ color: '#f59e0b' }}>⚠</span> {f}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', fontSize: 12, border: '1px dashed #e2e8f0', borderRadius: 10 }}>
            <span className="material-symbols-outlined" style={{ fontSize: 32, display: 'block', marginBottom: 8 }}>touch_app</span>
            Select a resource to view prediction details
          </div>
        )}
      </div>
    </div>
  )
}
