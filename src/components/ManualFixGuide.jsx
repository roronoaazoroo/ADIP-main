// ============================================================
// FILE: src/components/ManualFixGuide.jsx
// ROLE: AI-generated step-by-step manual fix guide
//       Shown when remediation mode is OFF (read-only mode)
// ============================================================
import React, { useState, useEffect } from 'react'
import './ManualFixGuide.css'

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api'

/**
 * Parse a plain-text AI response into an array of bullet strings.
 * Handles:
 *  - Numbered lists  "1. Do this"
 *  - Bullet lines    "- Do this" / "• Do this" / "* Do this"
 *  - Blank-line-separated paragraphs
 */
function parseBullets(text) {
  if (!text) return []
  return text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => l.replace(/^(\d+[\.\)]\s*|[-•*]\s*)/, '').trim())
    .filter(Boolean)
}

export default function ManualFixGuide({ resourceId, resourceType, displayName, differences }) {
  const [guide, setGuide]     = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)

  useEffect(() => {
    if (!differences?.length) return
    setLoading(true)
    setError(null)

    const token = sessionStorage.getItem('adip.token')
    fetch(`${API_BASE}/manual-guide`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
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
        <h3>
          Manual Fix Guide{' '}
          <span style={{ fontWeight: 400, fontSize: 13, opacity: 0.55 }}>(Read-Only Mode)</span>
        </h3>
      </div>

      <div className="mfg-body">
        {loading && (
          <div className="mfg-loading">
            <span className="mfg-spinner" />
            Generating step-by-step guide with AI…
          </div>
        )}

        {error && <p className="mfg-error">⚠ Failed to generate guide: {error}</p>}

        {!loading && !guide && !error && (
          <p className="mfg-empty">No changes to fix.</p>
        )}

        {/* Plain-text AI response — rendered as bullet list */}
        {guide && typeof guide === 'string' && (() => {
          const bullets = parseBullets(guide)
          if (bullets.length <= 1) {
            // Very short response — just show as text
            return <div className="mfg-plain-text">{guide}</div>
          }
          return (
            <ul className="mfg-bullet-list">
              {bullets.map((item, i) => (
                <li key={i} className="mfg-bullet-item">
                  <span className="mfg-bullet-dot" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          )
        })()}

        {/* Structured step list (when backend returns JSON array) */}
        {guide && Array.isArray(guide) && guide.map((step, index) => (
          <div key={index} className="mfg-step">
            <div className="mfg-step-title">
              <span className="mfg-step-number">{index + 1}</span>
              {step.title || step.action || `Step ${index + 1}`}
            </div>

            {step.description && (
              <div className="mfg-step-desc">{step.description}</div>
            )}

            {step.portal && (
              <div className="mfg-step-portal">
                <strong>Portal:</strong> {step.portal}
              </div>
            )}

            {step.cli && (
              <div className="mfg-step-cli">
                <strong>CLI:</strong>
                <code className="mfg-code">{step.cli}</code>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
