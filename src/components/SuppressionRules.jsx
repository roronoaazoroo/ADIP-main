// FILE: src/components/SuppressionRules.jsx
// ROLE: Drift Suppression Rules manager — CRUD UI for rules stored in Azure Table Storage.
//
// Fixes applied:
//   - subscriptionId sourced from prop → context → VITE env var (all three fallbacks)
//   - fetchResourceGroups called with subscriptionId, not empty string
//   - fetchResources called with rg.id (full ARM path) not rg.name
//   - Rules reload after successful add
//   - Error shown inline per operation (not shared state)
//   - "Add Rule" disabled until subscriptionId is resolved

import { useState, useEffect } from 'react'
import { useDashboard } from '../context/DashboardContext'
import {
  fetchSuppressionRules, createSuppressionRule, deleteSuppressionRule,
  fetchResourceGroups, fetchResources,
} from '../services/api'

const COMMON_FIELDS = [
  'tags', 'properties.provisioningState', 'properties.networkAcls',
  'properties.encryption', 'properties.minimumTlsVersion',
  'properties.supportsHttpsTrafficOnly', 'properties.allowBlobPublicAccess',
  'sku', 'identity',
]

export default function SuppressionRules({ subscriptionId: propSubId }) {
  const { subscription: ctxSubId } = useDashboard()
  // Priority: prop → context → Vite env var
  const subId = propSubId || ctxSubId || import.meta.env.VITE_AZURE_SUBSCRIPTION_ID || ''

  const [rules,    setRules]    = useState([])
  const [loading,  setLoading]  = useState(false)
  const [listError, setListError] = useState(null)
  const [saving,   setSaving]   = useState(false)
  const [saveError, setSaveError] = useState(null)

  // Form state
  const [rgList,       setRgList]       = useState([])
  const [resourceList, setResourceList] = useState([])
  const [selRg,        setSelRg]        = useState('')   // rg.id (full ARM path)
  const [selResource,  setSelResource]  = useState('')   // resource.id (full ARM path)
  const [fieldPath,    setFieldPath]    = useState('')
  const [reason,       setReason]       = useState('')

  // Load rules
  useEffect(() => {
    if (!subId) return
    setLoading(true)
    setListError(null)
    fetchSuppressionRules(subId)
      .then(data => setRules(Array.isArray(data) ? data : []))
      .catch(err => setListError(err.message))
      .finally(() => setLoading(false))
  }, [subId])

  // Load resource groups
  useEffect(() => {
    if (!subId) return
    fetchResourceGroups(subId)
      .then(rgs => setRgList(Array.isArray(rgs) ? rgs : []))
      .catch(() => {})
  }, [subId])

  // Load resources when RG selected — use rg.id (full ARM path) for the API call
  useEffect(() => {
    setSelResource('')
    setResourceList([])
    if (!subId || !selRg) return
    fetchResources(subId, selRg)
      .then(res => setResourceList(Array.isArray(res) ? res : []))
      .catch(() => {})
  }, [subId, selRg])

  const handleAdd = async () => {
    if (!fieldPath.trim() || !subId) return
    setSaving(true)
    setSaveError(null)
    try {
      // Send rg name (not full ARM id) as resourceGroupId — compare.js uses .includes() match
      const rgName = selRg ? selRg.split('/').pop() : ''
      const rule = await createSuppressionRule(
        subId, fieldPath.trim(), rgName, selResource, ['all'], reason.trim()
      )
      setRules(prev => [...prev, rule])
      // Reset form
      setFieldPath(''); setReason(''); setSelRg(''); setSelResource(''); setChangeTypes(['all'])
    } catch (err) {
      setSaveError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (rowKey) => {
    try {
      await deleteSuppressionRule(subId, rowKey)
      setRules(prev => prev.filter(r => r.rowKey !== rowKey))
    } catch (err) {
      setListError(err.message)
    }
  }

  const scopeLabel = (rule) => {
    if (rule.resourceId)      return rule.resourceId.split('/').pop()
    if (rule.resourceGroupId) return rule.resourceGroupId
    return 'All resources'
  }

  if (!subId) {
    return (
      <div style={{ color: '#f59e0b', fontSize: 13 }}>
        ⚠ No subscription selected. Go to Drift Scanner and select a subscription first.
      </div>
    )
  }

  return (
    <div>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 16 }}>
        Fields matching these rules are ignored during drift comparison and will not trigger alerts.
      </p>

      {listError && <div style={{ color: '#ef4444', fontSize: 13, marginBottom: 12 }}>⚠ {listError}</div>}

      {/* Rules table */}
      {loading ? (
        <div style={{ color: '#94a3b8', fontSize: 13, marginBottom: 16 }}>Loading rules…</div>
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

        <div className="sp-form-field">
          <label className="sp-form-label">Resource Group (optional)</label>
          <select className="sp-select" value={selRg} onChange={e => setSelRg(e.target.value)}>
            <option value="">All resource groups</option>
            {rgList.map(rg => <option key={rg.id} value={rg.id}>{rg.name}</option>)}
          </select>
        </div>

        <div className="sp-form-field">
          <label className="sp-form-label">Resource (optional)</label>
          <select className="sp-select" value={selResource} onChange={e => setSelResource(e.target.value)} disabled={!selRg}>
            <option value="">All resources in group</option>
            {resourceList.map(r => <option key={r.id} value={r.id}>{r.name || r.id.split('/').pop()}</option>)}
          </select>
        </div>

<div className="sp-form-field">
          <label className="sp-form-label">Field Path to Suppress *</label>
          <input className="sp-input" list="field-suggestions" value={fieldPath}
            onChange={e => setFieldPath(e.target.value)}
            placeholder="e.g. tags or properties.provisioningState" />
          <datalist id="field-suggestions">
            {COMMON_FIELDS.map(f => <option key={f} value={f} />)}
          </datalist>
        </div>

        <div className="sp-form-field">
          <label className="sp-form-label">Reason</label>
          <input className="sp-input" value={reason} onChange={e => setReason(e.target.value)}
            placeholder="Why is this suppressed?" />
        </div>
      </div>

      {saveError && <div style={{ color: '#ef4444', fontSize: 13, marginTop: 8 }}>⚠ {saveError}</div>}

      <button className="cp-btn cp-btn--secondary" style={{ marginTop: 12 }}
        onClick={handleAdd} disabled={saving || !fieldPath.trim() || !subId}>
        <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
        {saving ? 'Saving…' : 'Add Rule'}
      </button>
    </div>
  )
}
