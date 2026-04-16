import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { diff as deepDiff } from 'deep-diff'
import JsonTree from '../components/JsonTree'
import NavBar from '../components/NavBar'
import { fetchBaseline, remediateToBaseline, fetchPolicyCompliance, fetchAiExplanation, fetchAiRecommendation, uploadBaseline, requestRemediation } from '../services/api'
import { useDashboard } from '../context/DashboardContext'
import './ComparisonPage.css'

const CRITICAL_PATHS = ['properties.networkAcls','properties.accessPolicies','properties.securityRules','sku','location','identity','properties.encryption']

function classifySeverity(differences) {
  if (!differences.length) return null
  if (differences.some(d => d.type === 'removed')) return 'critical'
  const tagChanges = differences.filter(d => d.path?.includes('tags'))
  if (tagChanges.length >= 3) return 'critical'
  if (differences.some(d => CRITICAL_PATHS.some(p => d.path.startsWith(p)))) return 'high'
  if (differences.length > 5) return 'medium'
  return 'low'
}

function formatDifferences(rawDiff) {
  if (!rawDiff) return []
  return rawDiff.map(d => {
    const path = d.path?.join(' → ') ?? '(root)'
    switch (d.kind) {
      case 'N': return { path, type: 'added',   label: 'Added',    newValue: d.rhs }
      case 'D': return { path, type: 'removed', label: 'Removed',  oldValue: d.lhs }
      case 'E': return { path, type: 'changed', label: 'Modified', oldValue: d.lhs, newValue: d.rhs }
      case 'A': return { path: `${path}[${d.index}]`, type: 'array', label: 'Array changed', oldValue: d.item?.lhs, newValue: d.item?.rhs }
      default:  return null
    }
  }).filter(Boolean)
}

function normaliseState(state) {
  if (!state) return {}
  const VOLATILE = ['etag','changedTime','createdTime','provisioningState','lastModifiedAt','systemData','_ts','_etag','_rid','_self']
  const strip = (obj) => {
    if (Array.isArray(obj)) return obj.map(strip)
    if (obj && typeof obj === 'object') return Object.fromEntries(Object.entries(obj).filter(([k]) => !VOLATILE.includes(k)).map(([k,v]) => [k, strip(v)]))
    return obj
  }
  return strip(JSON.parse(JSON.stringify(state)))
}

const SEV_COLOR = { critical: '#dc2626', high: '#ea580c', medium: '#ca8a04', low: '#16a34a' }

function ValueChip({ value, variant }) {
  const full = value === undefined ? '—' : JSON.stringify(value)
  const display = full.length > 80 ? full.slice(0, 80) + '…' : full
  return <span className={`cp-value-chip cp-value-chip--${variant}`} title={full !== display ? full : undefined}>{display}</span>
}

export default function ComparisonPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const state = location.state ?? {}
  const { subscriptionId, resourceGroupId, resourceId, resourceName, liveState: passedLive } = state
  const effectiveId = resourceId || resourceGroupId
  const { subscription, resourceGroup, resource, configData } = useDashboard()
  const user = (() => { try { return JSON.parse(sessionStorage.getItem('user') || '{}') } catch { return {} } })()

  const [baseline, setBaseline] = useState(null)
  const [differences, setDifferences] = useState([])
  const [severity, setSeverity] = useState(null)
  const [loading, setLoading] = useState(false)
  const [noBaseline, setNoBaseline] = useState(false)
  const [remediating, setRemediating] = useState(false)
  const [remediated, setRemediated] = useState(false)
  const [remediateErr, setRemediateErr] = useState(null)
  const [remediateDiff, setRemediateDiff] = useState(null)
  const [policyData, setPolicyData] = useState(null)
  const [aiExplanation, setAiExplanation] = useState(null)
  const [aiRecommend, setAiRecommend] = useState(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadMsg, setUploadMsg] = useState(null)
  const baselineTreeRef = useRef(null)
  const liveTreeRef = useRef(null)

  useEffect(() => {
    if (!subscriptionId) return
    setLoading(true)
    fetchPolicyCompliance(subscriptionId, resourceGroupId, resourceId).then(setPolicyData).catch(() => {})
    fetchBaseline(subscriptionId, effectiveId).then(data => {
      if (data?.resourceState) {
        const normBaseline = normaliseState(data.resourceState)
        const normLive = normaliseState(passedLive)
        setBaseline(normBaseline)
        const rawDiff = deepDiff(normBaseline, normLive) || []
        const fmtDiff = formatDifferences(rawDiff)
        setDifferences(fmtDiff)
        setSeverity(classifySeverity(fmtDiff))
        if (fmtDiff.length > 0) {
          setAiLoading(true)
          fetchAiExplanation({ resourceId, resourceGroup: resourceGroupId, subscriptionId, severity: classifySeverity(fmtDiff), differences: fmtDiff, changes: fmtDiff })
            .then(r => setAiExplanation(r?.explanation || null)).catch(() => {}).finally(() => setAiLoading(false))
        }
      } else { setNoBaseline(true) }
    }).catch(() => setNoBaseline(true)).finally(() => setLoading(false))
  }, [subscriptionId, resourceId])

  const handleRemediate = async () => {
    setRemediating(true); setRemediateErr(null); setRemediateDiff(null)
    fetchAiRecommendation({ resourceId, resourceGroup: resourceGroupId, subscriptionId, severity, differences, changes: differences })
      .then(r => setAiRecommend(r?.recommendation || null)).catch(() => {})
    try {
      const normLive = normaliseState(passedLive)
      setRemediateDiff(formatDifferences(deepDiff(baseline || {}, normLive) || []))
      if (severity === 'low') {
        await remediateToBaseline(subscriptionId, resourceGroupId, effectiveId)
      } else {
        const sessionUser = (() => { try { return JSON.parse(sessionStorage.getItem('user') || '{}') } catch { return {} } })()
        await requestRemediation({ subscriptionId, resourceGroupId, resourceId: effectiveId, differences, changes: differences, severity, caller: sessionUser.name || 'Dashboard User' })
      }
      setRemediated(true)
    } catch (err) { setRemediateErr(err.message) }
    finally { setRemediating(false) }
  }

  const handleUpload = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.name.endsWith('.json')) { setUploadMsg({ ok: false, text: 'Only .json files are accepted.' }); return }
    const reader = new FileReader()
    reader.onload = async (ev) => {
      let parsed
      try { parsed = JSON.parse(ev.target.result) } catch { setUploadMsg({ ok: false, text: 'Invalid JSON.' }); return }
      if (parsed.$schema?.includes('deploymentTemplate') && Array.isArray(parsed.resources)) {
        parsed = parsed.resources[0]
        if (!parsed) { setUploadMsg({ ok: false, text: 'ARM template has no resources.' }); return }
      }
      setUploading(true); setUploadMsg(null)
      try {
        await uploadBaseline(subscriptionId, resourceGroupId, effectiveId, parsed)
        const fresh = await fetchBaseline(subscriptionId, effectiveId)
        if (fresh?.resourceState) {
          const nb = normaliseState(fresh.resourceState), nl = normaliseState(passedLive)
          const fd = formatDifferences(deepDiff(nb, nl) || [])
          setBaseline(nb); setDifferences(fd); setSeverity(classifySeverity(fd)); setNoBaseline(false)
          setUploadMsg({ ok: true, text: 'Baseline uploaded and applied.' })
        } else { setNoBaseline(true); setUploadMsg({ ok: false, text: 'Upload succeeded but baseline not found.' }) }
      } catch (err) { setUploadMsg({ ok: false, text: `Upload failed: ${err.message}` }) }
      finally { setUploading(false); e.target.value = '' }
    }
    reader.readAsText(file)
  }

  const expandAll = useCallback(() => { baselineTreeRef.current?.expandAll(); liveTreeRef.current?.expandAll() }, [])
  const collapseAll = useCallback(() => { baselineTreeRef.current?.collapseAll(); liveTreeRef.current?.collapseAll() }, [])
  const displayName = resourceName ?? resourceId?.split('/').pop() ?? resourceGroupId

  if (!subscriptionId || !passedLive) {
    return (
      <div className="cp-root">
        <NavBar user={user} subscription={subscription} resourceGroup={resourceGroup} resource={resource} configData={configData} />
        <div className="cp-empty-state">
          <span className="material-symbols-outlined" style={{ fontSize: 48, color: '#c2c7d0' }}>compare_arrows</span>
          <p>No comparison data. Navigate here from the Drift Scanner.</p>
          <button className="cp-btn cp-btn--primary" onClick={() => navigate('/dashboard')}>← Go to Drift Scanner</button>
        </div>
      </div>
    )
  }

  return (
    <div className="cp-root">
      <NavBar user={user} subscription={subscription} resourceGroup={resourceGroup} resource={resource} configData={configData} />

      <main className="cp-main">
        {/* Page header */}
        <header className="cp-header">
          <div>
            <h1 className="cp-headline">Baseline Comparison</h1>
            <p className="cp-subline">
              <span className="cp-breadcrumb">{subscriptionId?.slice(0,8)}…</span>
              <span className="cp-sep">›</span>
              <span className="cp-breadcrumb">{resourceGroupId}</span>
              <span className="cp-sep">›</span>
              <span className="cp-breadcrumb cp-breadcrumb--active">{displayName}</span>
            </p>
          </div>
          <div className="cp-header-actions">
            {severity && <span className="cp-severity-badge" style={{ background: `${SEV_COLOR[severity]}18`, color: SEV_COLOR[severity], border: `1px solid ${SEV_COLOR[severity]}40` }}>{severity.toUpperCase()}</span>}
            {policyData?.nonCompliant > 0 && <span className="cp-severity-badge" style={{ background: '#dc262618', color: '#dc2626', border: '1px solid #dc262640' }}>POLICY: {policyData.nonCompliant} VIOLATION(S)</span>}
            <label className="cp-btn cp-btn--secondary" style={{ cursor: 'pointer' }}>
              <input type="file" accept=".json" onChange={handleUpload} style={{ display: 'none' }} disabled={uploading} />
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>upload</span>
              {uploading ? 'Uploading...' : 'Upload Baseline'}
            </label>
            {differences.length > 0 && !noBaseline && (
              <button className={`cp-btn ${severity === 'low' ? 'cp-btn--green' : 'cp-btn--primary'}`} onClick={handleRemediate} disabled={remediating || remediated}>
                {remediating ? <><div className="cp-spinner" />{severity === 'low' ? 'Applying...' : 'Sending...'}</> :
                 remediated ? (severity === 'low' ? '✓ Remediated!' : '✓ Request Sent!') :
                 severity === 'low' ? 'Apply Fix Now' : 'Request Approval'}
              </button>
            )}
          </div>
        </header>

        {/* Alerts */}
        {uploadMsg && <div className={`cp-alert cp-alert--${uploadMsg.ok ? 'success' : 'error'}`}>{uploadMsg.text}</div>}
        {remediateErr && <div className="cp-alert cp-alert--error">Failed to remediate: {remediateErr}</div>}
        {remediated && remediateDiff !== null && (
          <div className="cp-alert cp-alert--success">
            <strong>{severity === 'low' ? '✓ Remediation applied.' : '✓ Approval request sent.'}</strong>
            {remediateDiff.length > 0 && <span> {remediateDiff.length} field change(s) queued.</span>}
          </div>
        )}

        {/* AI cards */}
        {(aiLoading || aiExplanation) && (
          <div className="cp-ai-card cp-ai-card--blue">
            <span className="material-symbols-outlined">smart_toy</span>
            <div>
              <div className="cp-ai-label">AI Security Analysis</div>
              <div className="cp-ai-text">{aiLoading ? 'Analysing drift with Azure OpenAI...' : aiExplanation}</div>
            </div>
          </div>
        )}
        {aiRecommend && (
          <div className="cp-ai-card cp-ai-card--green">
            <span className="material-symbols-outlined">lightbulb</span>
            <div>
              <div className="cp-ai-label">AI Remediation Recommendation</div>
              <div className="cp-ai-text">{aiRecommend}</div>
            </div>
          </div>
        )}

        {/* Loading */}
        {loading && <div className="cp-loading"><div className="cp-loading-ring" /><span>Loading golden baseline...</span></div>}

        {/* No baseline */}
        {!loading && noBaseline && (
          <div className="cp-card cp-card--center">
            <span className="material-symbols-outlined" style={{ fontSize: 48, color: '#c2c7d0' }}>layers</span>
            <p>No golden baseline found for <strong>{displayName}</strong>.</p>
            <button className="cp-btn cp-btn--primary" onClick={handleRemediate} disabled={remediating || remediated}>
              {remediating ? 'Seeding...' : remediated ? '✓ Done!' : 'Promote Current State as Baseline'}
            </button>
          </div>
        )}

        {/* Changes summary */}
        {!loading && baseline && (
          <div className="cp-card">
            <div className="cp-card-header">
              <span className="material-symbols-outlined" style={{ color: '#0060a9' }}>info</span>
              <h3>{differences.length === 0 ? 'In sync with baseline' : `${differences.length} change(s) detected`}</h3>
              {differences.length === 0 && <span className="cp-sync-badge">✓ No drift</span>}
            </div>
            {differences.length > 0 && (
              <div className="cp-changes-list">
                {differences.map((d, i) => (
                  <div key={i} className={`cp-change cp-change--${d.type}`}>
                    <div className="cp-change-header">
                      <span className={`cp-change-badge cp-change-badge--${d.type}`}>{d.label}</span>
                      <code className="cp-change-path">{d.path}</code>
                    </div>
                    <div className="cp-change-values">
                      {d.oldValue !== undefined && <ValueChip value={d.oldValue} variant="old" />}
                      {d.oldValue !== undefined && d.newValue !== undefined && <span className="cp-arrow">→</span>}
                      {d.newValue !== undefined && <ValueChip value={d.newValue} variant="new" />}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* JSON panels */}
        {!loading && (baseline || passedLive) && (
          <div className="cp-json-row">
            <div className="cp-json-panel">
              <div className="cp-json-panel-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="cp-dot cp-dot--baseline" />
                  <h3>Golden Baseline</h3>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="cp-toolbar-btn" onClick={expandAll}><span className="material-symbols-outlined">unfold_more</span></button>
                  <button className="cp-toolbar-btn" onClick={collapseAll}><span className="material-symbols-outlined">unfold_less</span></button>
                  <span className="cp-arm-badge">ARM</span>
                </div>
              </div>
              <div className="cp-json-body">
                {baseline ? <JsonTree ref={baselineTreeRef} data={baseline} /> : <div className="cp-json-empty">No baseline stored</div>}
              </div>
            </div>
            <div className="cp-json-panel">
              <div className="cp-json-panel-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="cp-dot cp-dot--live" />
                  <h3>Live State</h3>
                </div>
                <span className="cp-arm-badge">ARM</span>
              </div>
              <div className="cp-json-body">
                <JsonTree ref={liveTreeRef} data={normaliseState(passedLive)} />
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
