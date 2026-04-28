// ============================================================
// FILE: src/components/SuppressionRules.jsx
// ROLE: Drift Suppression Rules manager for SettingsPage
//
// Form fields:
//   1. Subscription (auto-filled from context/env)
//   2. Resource Group dropdown (loaded from API)
//   3. Resource dropdown (optional, loaded after RG selected)
//   4. Change Types multi-select (added, removed, modified, all)
//   5. Field Path (what to suppress, e.g. "tags")
//   6. Reason
//
// Rules stored in Azure Table Storage (suppressionRules table).
// Applied server-side in compare.js before severity classification.
// ============================================================
import React, { useState, useEffect } from 'react'
import {
  fetchSuppressionRules, createSuppressionRule, deleteSuppressionRule,
  fetchResourceGroups, fetchResources,
} from '../services/api'

const ENV_SUB_ID = import.meta.env.VITE_AZURE_SUBSCRIPTION_ID || ''

const CHANGE_TYPE_OPTIONS = [
  { value: 'all',      label: 'All changes' },
  { value: 'added',    label: 'Added' },
  { value: 'removed',  label: 'Removed' },
  { value: 'modified', label: 'Modified' },
]

const COMMON_FIELDS = [
  'tags', 'properties.provisioningState', 'properties.networkAcls',
  'properties.encryption', 'properties.minimumTlsVersion',
  'properties.supportsHttpsTrafficOnly', 'properties.allowBlobPublicAccess',
  'sku', 'identity',
]

export default function SuppressionRules({ subscriptionId: propSubId }) {
  const effectiveSubId = propSubId || ENV_SUB_ID

  const [rules,    setRules]    = useState([])
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState(null)
  const [saving,   setSaving]   = useState(false)

  // Form state
  const [rgList,       setRgList]       = useState([])
  const [resourceList, setResourceList] = useState([])
  const [selRg,        setSelRg]        = useState('')
  const [selResource,  setSelResource]  = useState('')
  const [changeTypes,  setChangeTypes]  = useState(['all'])
  const [fieldPath,    setFieldPath]    = useState('')
  const [reason,       setReason]       = useState('')

  // Load rules
  useEffect(() => {
    if (!effectiveSubId) return
    setLoading(true)
    fetchSuppressionRules(effectiveSubId)
      .then(data => setRules(data || []))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [effectiveSubId])

  // Load resource groups when subscription is known
  useEffect(() => {
    if (!effectiveSubId) return
    fetchResourceGroups(effectiveSubId)
      .then(rgs => setRgList(rgs || []))
      .catch(() => {})
  }, [effectiveSubId])

  // Load resources when RG is selected
  useEffect(() => {
    setSelResource('')
    setResourceList([])
    if (!effectiveSubId || !selRg) return
    fetchResources(effectiveSubId, selRg)
      .then(res => setResourceList(res || []))
      .catch(() => {})
  }, [effectiveSubId, selRg])

  const toggleChangeType = (val) => {
    if (val === 'all') { setChangeTypes(['all']); return }
    setChangeTypes(prev => {
      const without = prev.filter(v => v !== 'all')
      return without.includes(val) ? without.filter(v => v !== val) : [...without, val]
    })
  }

  const handleAdd = async () => {
    if (!fieldPath.trim() || !effectiveSubId) return
    setSaving(true)
    setError(null)
    try {
      const rule = await createSuppressionRule(
        effectiveSubId,
        fieldPath.trim(),
        selRg,
        selResource,
        changeTypes,
        reason.trim()
      )
      setRules(prev => [...prev, rule])
      setFieldPath(''); setReason(''); setSelRg(''); setSelResource(''); setChangeTypes(['all'])
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

  const scopeLabel = (rule) => {
    if (rule.resourceId) return rule.resourceId.split('/').pop()
    if (rule.resourceGroupId) return rule.resourceGroupId
    return 'All resources'
  }

  return (
    <div>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
        Fields matching these rules are ignored during drift comparison and will not trigger alerts.
      </p>

      {error && <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 12 }}>{error}</div>}

      {/* Rules table */}
      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 13, marginBottom: 16 }}>Loading rules...</div>
      ) : (
        <table className="an-table" style={{ marginBottom: 24 }}>
          <thead>
            <tr><th>Field Path</th><th>Scope</th><th>Change Types</th><th>Reason</th><th style={{ width: 40 }}>Del</th></tr>
          </thead>
          <tbody>
            {rules.length === 0 && (
              <tr><td colSpan={5} style={{ color: '#64748b', fontSize: 13, padding: '12px 8px' }}>No suppression rules yet.</td></tr>
            )}
            {rules.map(rule => (
              <tr key={rule.rowKey} className="an-tr">
                <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{rule.fieldPath}</td>
                <td style={{ fontSize: 12 }}>{scopeLabel(rule)}</td>
                <td style={{ fontSize: 12 }}>{(rule.changeTypes?.length ? rule.changeTypes : ['all']).join(', ')}</td>
                <td style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{rule.reason || '—'}</td>
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

        {/* Resource Group */}
        <div className="sp-form-field">
          <label className="sp-form-label">Resource Group (optional)</label>
          <select className="sp-select" value={selRg} onChange={e => setSelRg(e.target.value)}>
            <option value="">All resource groups</option>
            {rgList.map(rg => <option key={rg.id || rg.name} value={rg.name || rg.id}>{rg.name || rg.id}</option>)}
          </select>
        </div>

        {/* Resource */}
        <div className="sp-form-field">
          <label className="sp-form-label">Resource (optional)</label>
          <select className="sp-select" value={selResource} onChange={e => setSelResource(e.target.value)} disabled={!selRg}>
            <option value="">All resources in group</option>
            {resourceList.map(r => <option key={r.id} value={r.id}>{r.name || r.id.split('/').pop()}</option>)}
          </select>
        </div>

        {/* Change Types */}
        <div className="sp-form-field">
          <label className="sp-form-label">Suppress Change Types</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
            {CHANGE_TYPE_OPTIONS.map(opt => (
              <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 13, cursor: 'pointer' }}>
                <input type="checkbox"
                  checked={changeTypes.includes(opt.value) || (opt.value !== 'all' && changeTypes.includes('all'))}
                  onChange={() => toggleChangeType(opt.value)} />
                {opt.label}
              </label>
            ))}
          </div>
        </div>

        {/* Field Path */}
        <div className="sp-form-field">
          <label className="sp-form-label">Field Path to Suppress</label>
          <input className="sp-input" list="field-suggestions" value={fieldPath}
            onChange={e => setFieldPath(e.target.value)}
            placeholder="e.g. tags or properties.provisioningState" />
          <datalist id="field-suggestions">
            {COMMON_FIELDS.map(f => <option key={f} value={f} />)}
          </datalist>
        </div>

        {/* Reason */}
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
