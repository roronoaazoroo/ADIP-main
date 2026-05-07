// ============================================================
// FILE: src/components/ManualFixGuide.jsx
// ROLE: AI-generated step-by-step manual fix guide
//       Shown when remediation mode is OFF (read-only mode)
// ============================================================
import React, { useState, useEffect } from 'react'

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api'

export default function ManualFixGuide({ resourceId, resourceType, displayName, differences }) {
  const [guide, setGuide] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!differences?.length) return
    setLoading(true)
    setError(null)

    const token = sessionStorage.getItem('adip.token')
    fetch(`${API_BASE}/manual-guide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ resourceId, resourceType, resourceName: displayName, differences }),
    })
      .then(res => res.json())
      .then(data => setGuide(data.guide || data))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [resourceId, differences?.length])

  return (
    <div className="cp-card" style={{ marginTop: 16 }}>
      <div className="cp-card-header">
        <span className="material-symbols-outlined" style={{ color: '#f59e0b' }}>menu_book</span>
        <h3>Manual Fix Guide (Read-Only Mode)</h3>
      </div>
      <div style={{ padding: '16px 20px', fontSize: 13, lineHeight: 1.9, color: 'var(--text-secondary)' }}>
        {loading && <p style={{ color: '#60a5fa' }}>⏳ Generating step-by-step guide with AI...</p>}
        {error && <p style={{ color: '#ef4444' }}>Failed to generate guide: {error}</p>}
        {!loading && !guide && !error && <p style={{ color: 'rgba(255,255,255,0.4)' }}>No changes to fix.</p>}
        {guide && typeof guide === 'string' && (
          <div style={{ whiteSpace: 'pre-wrap' }}>{guide}</div>
        )}
        {guide && Array.isArray(guide) && guide.map((step, index) => (
          <div key={index} style={{ padding: '12px 14px', marginBottom: 10, background: 'rgba(255,255,255,0.02)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>Step {index + 1}: {step.title || step.action || ''}</div>
            {step.description && <div style={{ marginBottom: 6 }}>{step.description}</div>}
            {step.portal && (
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>
                <strong>Portal:</strong> {step.portal}
              </div>
            )}
            {step.cli && (
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
                <strong>CLI:</strong> <code style={{ background: 'rgba(255,255,255,0.05)', padding: '2px 8px', borderRadius: 4, display: 'inline-block', marginTop: 2 }}>{step.cli}</code>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
