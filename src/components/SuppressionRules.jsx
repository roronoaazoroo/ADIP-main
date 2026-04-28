// ============================================================
// FILE: src/components/SuppressionRules.jsx
// ROLE: Drift Suppression Rules manager for SettingsPage
//
// Loads rules from Azure Table Storage, allows adding/deleting.
// Rules are applied server-side during diff computation in compare.js.
//
// Props: subscriptionId
// ============================================================
import React, { useState, useEffect } from 'react'
import { fetchSuppressionRules, createSuppressionRule, deleteSuppressionRule } from '../services/api'

const ENV_SUB_ID = import.meta.env.VITE_AZURE_SUBSCRIPTION_ID || ''

export default function SuppressionRules({ subscriptionId: propSubId }) {
  const [subInput,    setSubInput]    = useState(propSubId || ENV_SUB_ID)
  const [rules,       setRules]       = useState([])
  const [loading,     setLoading]     = useState(false)
  const [error,       setError]       = useState(null)
  const [fieldPath,   setFieldPath]   = useState('')
  const [resourceType, setResourceType] = useState('All')
  const [reason,      setReason]      = useState('')
  const [saving,      setSaving]      = useState(false)

  const effectiveSubId = propSubId || subInput

  useEffect(() => { if (propSubId) setSubInput(propSubId) }, [propSubId])

  useEffect(() => {
    if (!effectiveSubId) return
    let cancelled = false
    setLoading(true)
    fetchSuppressionRules(effectiveSubId)
      .then(data  => { if (!cancelled) setRules(data || []) })
      .catch(err  => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [effectiveSubId])

  const handleAdd = async () => {
    if (!fieldPath.trim() || !effectiveSubId) return
    setSaving(true)
    try {
      const rule = await createSuppressionRule(effectiveSubId, fieldPath.trim(), resourceType, reason.trim())
      setRules(prev => [...prev, rule])
      setFieldPath('')
      setReason('')
      setResourceType('All')
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (rowKey) => {
    try {
      await deleteSuppressionRule(effectiveSubId, rowKey)
      setRules(prev => prev.filter(r => r.rowKey !== rowKey))
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
        Fields matching these rules are ignored during baseline comparison and will not trigger drift alerts.
      </p>

      {error && <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 12 }}>{error}</div>}

      {/* Subscription input when not in context */}
      {!propSubId && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <label className="sp-form-label">Subscription ID</label>
          <input className="sp-input" style={{ maxWidth: 340 }} type="text"
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            value={subInput} onChange={e => setSubInput(e.target.value.trim())} />
        </div>
      )}

      {/* Rules table */}
      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 13, marginBottom: 16 }}>Loading rules...</div>
      ) : (
        <table className="an-table" style={{ marginBottom: 24 }}>
          <thead>
            <tr><th>Field Path</th><th>Resource Type</th><th>Reason</th><th style={{ width: 60 }}>Delete</th></tr>
          </thead>
          <tbody>
            {rules.length === 0 && (
              <tr><td colSpan={4} style={{ color: '#64748b', fontSize: 13, padding: '12px 8px' }}>No suppression rules yet.</td></tr>
            )}
            {rules.map(rule => (
              <tr key={rule.rowKey} className="an-tr">
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{rule.fieldPath}</td>
                <td>{rule.resourceType}</td>
                <td style={{ color: 'var(--text-secondary)' }}>{rule.reason || '—'}</td>
                <td>
                  <button className="cp-toolbar-btn" onClick={() => handleDelete(rule.rowKey)}>
                    <span className="material-symbols-outlined" style={{ fontSize: 16, color: '#ef4444' }}>delete</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Add rule form */}
      <div className="sp-form-grid" style={{ gap: 12 }}>
        <div className="sp-form-field">
          <label className="sp-form-label">Field Path</label>
          <input className="sp-input" value={fieldPath} onChange={e => setFieldPath(e.target.value)}
            placeholder="e.g. tags or properties.provisioningState" />
        </div>
        <div className="sp-form-field">
          <label className="sp-form-label">Resource Type (or "All")</label>
          <input className="sp-input" value={resourceType} onChange={e => setResourceType(e.target.value)}
            placeholder="e.g. Microsoft.Storage/storageAccounts" />
        </div>
        <div className="sp-form-field">
          <label className="sp-form-label">Reason</label>
          <input className="sp-input" value={reason} onChange={e => setReason(e.target.value)}
            placeholder="Why is this suppressed?" />
        </div>
      </div>
      <button className="cp-btn cp-btn--secondary" style={{ marginTop: 12 }}
        onClick={handleAdd} disabled={saving || !fieldPath.trim() || !effectiveSubId}>
        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
        {saving ? 'Saving...' : 'Add Rule'}
      </button>
    </div>
  )
}
