import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { diff as deepDiff } from 'deep-diff'
import Sidebar from '../components/Sidebar'
import JsonTree from '../components/JsonTree'
import { fetchBaseline, remediateToBaseline, fetchPolicyCompliance, fetchAiExplanation, fetchAiRecommendation, uploadBaseline, requestRemediation } from '../services/api'
import './ComparisonPage.css'

// ── Severity classifier ────────────────────────────────────────────────────
const CRITICAL_PATHS = [
  'properties.networkAcls', 'properties.accessPolicies', 'properties.securityRules',
  'sku', 'location', 'identity', 'properties.encryption',
]

function classifySeverity(differences) {
  if (!differences.length) return null
  if (differences.some(d => d.type === 'removed')) return 'critical'
  const tagChanges = differences.filter(d => d.path?.includes('tags'))
  if (tagChanges.length >= 3) return 'critical'
  if (differences.some(d => CRITICAL_PATHS.some(p => d.path.startsWith(p)))) return 'high'
  if (differences.length > 5) return 'medium'
  return 'low'
}

// ── Normalise deep-diff output into readable change entries ─────────────────
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

// Strip volatile fields before diffing (same list as the backend Function App)
function normaliseState(state) {
  if (!state) return {}
  const VOLATILE = ['etag', 'changedTime', 'createdTime', 'provisioningState', 'lastModifiedAt', 'systemData', '_ts', '_etag', '_rid', '_self']
  const strip = (obj) => {
    if (Array.isArray(obj)) return obj.map(strip)
    if (obj && typeof obj === 'object') {
      return Object.fromEntries(
        Object.entries(obj).filter(([k]) => !VOLATILE.includes(k)).map(([k, v]) => [k, strip(v)])
      )
    }
    return obj
  }
  return strip(JSON.parse(JSON.stringify(state)))
}

// ── Value display helper ────────────────────────────────────────────────────
function ValueChip({ value, variant }) {
  const display = value === undefined ? '—' : JSON.stringify(value)
  return <span className={`value-chip value-chip--${variant}`}>{display}</span>
}

export default function ComparisonPage() {
  const navigate  = useNavigate()
  const location  = useLocation()
  const state     = location.state ?? {}

  const { subscriptionId, resourceGroupId, resourceId, resourceName, liveState: passedLive } = state
  // Use resourceId if a specific resource was selected, otherwise fall back to resourceGroupId
  const effectiveId = resourceId || resourceGroupId

  const [baseline,       setBaseline]       = useState(null)
  const [differences,    setDifferences]    = useState([])
  const [severity,       setSeverity]       = useState(null)
  const [loading,        setLoading]        = useState(false)
  const [noBaseline,     setNoBaseline]     = useState(false)
  const [remediating,    setRemediating]    = useState(false)
  const [remediated,     setRemediated]     = useState(false)
  const [remediateErr,   setRemediateErr]   = useState(null)
  const [remediateDiff,  setRemediateDiff]  = useState(null)
  const [policyData,     setPolicyData]     = useState(null)
  const [aiExplanation,  setAiExplanation]  = useState(null)
  const [aiRecommend,    setAiRecommend]    = useState(null)
  const [aiLoading,      setAiLoading]      = useState(false)
  const [uploading,      setUploading]      = useState(false)
  const [uploadMsg,      setUploadMsg]      = useState(null)
  const [requesting,     setRequesting]     = useState(false)
  const [requestMsg,     setRequestMsg]     = useState(null)

  const baselineTreeRef = useRef(null)
  const liveTreeRef     = useRef(null)

  // Load baseline from Cosmos DB via backend
  useEffect(() => {
    if (!subscriptionId) return
    const load = async () => {
      setLoading(true)
      // Fetch baseline and policy compliance in parallel
      fetchPolicyCompliance(subscriptionId, resourceGroupId, resourceId).then(setPolicyData).catch(() => {})
      try {
        const data = await fetchBaseline(subscriptionId, effectiveId)
        if (data?.resourceState) {
          const normBaseline = normaliseState(data.resourceState)
          const normLive     = normaliseState(passedLive)
          setBaseline(normBaseline)
          const rawDiff = deepDiff(normBaseline, normLive) || []
          const fmtDiff = formatDifferences(rawDiff)
          setDifferences(fmtDiff)
          setSeverity(classifySeverity(fmtDiff))
          // Feature 1: AI explanation (non-blocking)
          if (fmtDiff.length > 0) {
            setAiLoading(true)
            fetchAiExplanation({
              resourceId, resourceGroup: resourceGroupId,
              subscriptionId, severity: classifySeverity(fmtDiff),
              differences: fmtDiff, changes: fmtDiff,
            }).then(r => { setAiExplanation(r?.explanation || null) })
              .catch(() => {}).finally(() => setAiLoading(false))
          }
        } else {
          setNoBaseline(true)
        }
      } catch {
        setNoBaseline(true)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [subscriptionId, resourceId])

  const handleRemediate = async () => {
    setRemediating(true)
    setRemediateErr(null)
    setRemediateDiff(null)
    fetchAiRecommendation({ resourceId, resourceGroup: resourceGroupId, subscriptionId,
      severity, differences, changes: differences })
      .then(r => setAiRecommend(r?.recommendation || null)).catch(() => {})
    try {
      const normLive = normaliseState(passedLive)
      const rawDiff  = deepDiff(baseline || {}, normLive) || []
      setRemediateDiff(formatDifferences(rawDiff))

      if (severity === 'low') {
        // Low severity: apply immediately, no email approval needed
        await remediateToBaseline(subscriptionId, resourceGroupId, resourceId)
        setRemediated(true)
      } else {
        // Critical / High / Medium: send approval email, wait for admin
        const sessionUser = (() => { try { return JSON.parse(sessionStorage.getItem('user') || '{}') } catch { return {} } })()
        await requestRemediation({
          subscriptionId, resourceGroupId, resourceId,
          differences, changes: differences, severity,
          caller: sessionUser.name || sessionUser.username || 'Dashboard User',
        })
        setRemediated(true)
      }
    } catch (err) {
      setRemediateErr(err.message)
    } finally {
      setRemediating(false)
    }
  }
  // Task 1: file upload handler with client-side JSON validation
  const handleUpload = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.name.endsWith('.json')) {
      setUploadMsg({ ok: false, text: 'Only .json files are accepted.' })
      return
    }
    const reader = new FileReader()
    reader.onload = async (ev) => {
      let parsed
      try { parsed = JSON.parse(ev.target.result) }
      catch { setUploadMsg({ ok: false, text: 'Invalid JSON — file could not be parsed.' }); return }

      // If user uploads an ARM template export, extract the first resource's config
      if (parsed.$schema?.includes('deploymentTemplate') && Array.isArray(parsed.resources)) {
        const res = parsed.resources[0]
        if (!res) { setUploadMsg({ ok: false, text: 'ARM template has no resources.' }); return }
        // Resolve [parameters('...')] references to their defaultValues
        const params = parsed.parameters || {}
        const resolveParam = (val) => {
          if (typeof val !== 'string') return val
          const m = val.match(/^\[parameters\('([^']+)'\)\]$/)
          return m ? (params[m[1]]?.defaultValue ?? val) : val
        }
        const resolveAll = (obj) => {
          if (typeof obj === 'string') return resolveParam(obj)
          if (Array.isArray(obj)) return obj.map(resolveAll)
          if (obj && typeof obj === 'object') return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveAll(v)]))
          return obj
        }
        parsed = resolveAll(res)
        setUploadMsg({ ok: true, text: `ARM template detected — extracted resource: ${parsed.name || parsed.type}` })
      }

      setUploading(true)
      setUploadMsg(null)
      try {
        await uploadBaseline(subscriptionId, resourceGroupId, effectiveId, parsed)
        setLoading(true)
        setNoBaseline(false)
        const fresh = await fetchBaseline(subscriptionId, effectiveId)
        if (fresh?.resourceState) {
          const normBaseline = normaliseState(fresh.resourceState)
          const normLive     = normaliseState(passedLive)
          const rawDiff = deepDiff(normBaseline, normLive) || []
          const fmtDiff = formatDifferences(rawDiff)
          setBaseline(normBaseline)
          setDifferences(fmtDiff)
          setSeverity(classifySeverity(fmtDiff))
          setUploadMsg({ ok: true, text: 'Golden baseline uploaded and applied. Comparison updated.' })
        } else {
          setNoBaseline(true)
          setUploadMsg({ ok: false, text: 'Upload succeeded but baseline could not be retrieved.' })
        }
        setLoading(false)
      } catch (err) {
        setUploadMsg({ ok: false, text: `Upload failed: ${err.message}` })
      } finally {
        setUploading(false)
        e.target.value = ''  // reset file input
      }
    }
    reader.readAsText(file)
  }


  const expandAll  = useCallback(() => { baselineTreeRef.current?.expandAll();  liveTreeRef.current?.expandAll()  }, [])
  const collapseAll = useCallback(() => { baselineTreeRef.current?.collapseAll(); liveTreeRef.current?.collapseAll() }, [])

  // Guard: no state passed (direct URL navigation)
  if (!subscriptionId || !passedLive) {
    return (
      <div className="dashboard">
        <Sidebar />
        <div className="dashboard-main-wrapper">
          <div className="comparison-no-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--ct-grey-300)" strokeWidth="1.5"><path d="M16 3h5v5M8 3H3v5M3 16v5h5M21 16v5h-5"/></svg>
            <p>No comparison data available. Please navigate here from the Drift Scanner.</p>
            <button className="btn btn-primary" style={{ width: 'auto' }} onClick={() => navigate('/dashboard')}>
              ← Go to Drift Scanner
            </button>
          </div>
        </div>
      </div>
    )
  }

  const displayName = resourceName ?? resourceId?.split('/').pop() ?? resourceGroupId

  return (
    <div className="dashboard">
      <Sidebar />

      <div className="dashboard-main-wrapper">
        {/* Navbar */}
        <nav className="dashboard-nav">
          <div className="dashboard-nav-left">
            <button className="back-btn" onClick={() => navigate('/dashboard')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
              Back
            </button>
            <div className="dashboard-nav-title">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--ct-coral-blue)" strokeWidth="2"><path d="M16 3h5v5M8 3H3v5M3 16v5h5M21 16v5h-5"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
              <span>Baseline Comparison</span>
            </div>
            <div className="comparison-breadcrumb">
              <span>{subscriptionId}</span>
              <span className="breadcrumb-sep">›</span>
              <span>{resourceGroupId}</span>
              <span className="breadcrumb-sep">›</span>
              <span className="breadcrumb-active">{displayName}</span>
            </div>
          </div>
          <div className="dashboard-nav-right">
            {severity && (
              <span className={`severity-badge severity-badge--${severity}`}>
                {severity.toUpperCase()}
              </span>
            )}
            {policyData && policyData.summary !== 'no-policies' && (
              <span className={`severity-badge severity-badge--${policyData.nonCompliant > 0 ? 'critical' : ' '}`}
                title={policyData.nonCompliant > 0 ? `${policyData.nonCompliant} policy violation(s)` : ' '}>
                {policyData.nonCompliant > 0 ? `POLICY: ${policyData.nonCompliant} VIOLATION(S)` : ' '}
              </span>
            )}
            {/* Upload Golden Baseline button */}
            <label style={{ cursor: 'pointer' }}>
              <input type="file" accept=".json" onChange={handleUpload} style={{ display: 'none' }} disabled={uploading} />
              <span className="btn btn-primary" style={{ width: 'auto', padding: '6px 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, opacity: uploading ? 0.6 : 1 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                {uploading ? 'Uploading...' : 'Upload Baseline'}
              </span>
            </label>

            {differences.length > 0 && !noBaseline && (
              <button
                className="btn btn-promote"
                onClick={handleRemediate}
                disabled={remediating || remediated}
              >
                {remediating ? (
                  <><div className="btn-spinner btn-spinner--dark" /><span>{severity === 'low' ? 'Applying...' : 'Sending request...'}</span></>
                ) : remediated ? (
                  <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg><span>{severity === 'low' ? 'Remediated!' : 'Request Sent!'}</span></>
                ) : (
                  <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 14l-4-4 4-4"/><path d="M5 10h11a4 4 0 0 1 0 8h-1"/></svg><span>{severity === 'low' ? 'Auto-Remediate (Low)' : 'Remediate to Baseline'}</span></>
                )}
              </button>
            )}
          </div>
        </nav>

        {/* Body */}
        <div className="comparison-body">

          {/* Upload feedback */}
          {uploadMsg && (
            <div className={`comparison-alert comparison-alert--${uploadMsg.ok ? 'success' : 'error'}`}>
              {uploadMsg.text}
            </div>
          )}

          {/* Promote error */}
          {remediateErr && (
            <div className="comparison-alert comparison-alert--error">
              Failed to remediate: {remediateErr}
            </div>
          )}

          {/* Auto Remediate feedback */}
          {requestMsg && (
            <div className={`comparison-alert comparison-alert--${requestMsg.ok ? 'success' : 'error'}`}>
              {requestMsg.text}
            </div>
          )}

          {/* Feature 1: AI Explanation */}
          {(aiLoading || aiExplanation) && (
            <div style={{ margin: '0 0 16px', padding: '14px 18px', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 18 }}>🤖</span>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#818cf8', marginBottom: 4 }}>AI Security Analysis</div>
                {aiLoading
                  ? <div style={{ fontSize: 13, color: '#94a3b8' }}>Analysing drift with Azure OpenAI...</div>
                  : <div style={{ fontSize: 13, color: '#000', lineHeight: 1.6 }}>{aiExplanation}</div>
                }
              </div>
            </div>
          )}

          {/* Feature 3: AI Remediation Recommendation */}
          {aiRecommend && (
            <div style={{ margin: '0 0 16px', padding: '14px 18px', background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 8, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span style={{ fontSize: 18 }}>💡</span>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#10b981', marginBottom: 4 }}>AI Remediation Recommendation</div>
                <div style={{ fontSize: 13, color: '#000', lineHeight: 1.6 }}>{aiRecommend}</div>
              </div>
            </div>
          )}

          {/* Promote diff output */}
          {remediated && remediateDiff !== null && (
            <div className="comparison-alert comparison-alert--success">
              <strong>{severity === 'low' ? '✓ Remediation applied — resource reverted to baseline.' : '✓ Approval request sent — an email has been dispatched to the administrator.'}</strong>
              {remediateDiff.length === 0 ? (
                <span> No changes detected — resource already matches the baseline.</span>
              ) : (
                <>
                  <span> Approval email sent for {remediateDiff.length} field change(s). Remediation will apply once approved.</span>
                  <div className="changes-list" style={{ marginTop: 8 }}>
                    {remediateDiff.map((d, i) => (
                      <div key={i} className={`change-entry change-entry--${d.type}`}>
                        <div className="change-entry-header">
                          <span className={`change-kind-badge change-kind-badge--${d.type}`}>{d.label}</span>
                          <code className="change-path">{d.path}</code>
                        </div>
                        <div className="change-values">
                          {d.oldValue !== undefined && <ValueChip value={d.oldValue} variant="old" />}
                          {d.oldValue !== undefined && d.newValue !== undefined && <span className="change-arrow">→</span>}
                          {d.newValue !== undefined && <ValueChip value={d.newValue} variant="new" />}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Loading state */}
          {loading && (
            <div className="comparison-loading">
              <div className="scanning-ring" style={{ width: 32, height: 32, border: '2px solid rgba(25,149,255,0.15)', borderTopColor: 'var(--ct-coral-blue)' }} />
              <span>Loading golden baseline...</span>
            </div>
          )}

          {/* No baseline */}
          {!loading && noBaseline && (
            <div className="panel comparison-no-baseline-panel">
              <div className="panel-body">
                <div className="panel-empty">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--ct-grey-300)" strokeWidth="1.5"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                  <p>No golden baseline found for <strong>{displayName}</strong>.</p>
                  <p style={{ fontSize: 12 }}>Promote the current live state as the first baseline to begin drift tracking.</p>
                  <button
                    className="btn btn-promote"
                    style={{ width: 'auto', marginTop: 8 }}
                    onClick={handleRemediate}
                    disabled={remediating || remediated}
                  >
                    {remediating ? 'Remediating...' : remediated ? '✓ Remediated!' : 'No baseline found — seed one first'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Change summary */}
          {!loading && baseline && (
            <section className="panel comparison-changes-panel">
              <div className="panel-header">
                <div className="panel-header-left">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--ct-coral-blue)" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  <h3>{differences.length === 0 ? 'In sync with baseline' : `Changes detected (${differences.length})`}</h3>
                </div>
                {differences.length === 0 && (
                  <span className="in-sync-badge">✓ No drift</span>
                )}
              </div>

              {differences.length > 0 && (
                <div className="panel-body comparison-changes-body">
                  <div className="changes-list">
                    {differences.map((d, i) => (
                      <div key={`${d.path}-${i}`} className={`change-entry change-entry--${d.type}`}>
                        <div className="change-entry-header">
                          <span className={`change-kind-badge change-kind-badge--${d.type}`}>{d.label}</span>
                          <code className="change-path">{d.path}</code>
                        </div>
                        <div className="change-values">
                          {d.oldValue !== undefined && (
                            <ValueChip value={d.oldValue} variant="old" />
                          )}
                          {d.oldValue !== undefined && d.newValue !== undefined && (
                            <span className="change-arrow">→</span>
                          )}
                          {d.newValue !== undefined && (
                            <ValueChip value={d.newValue} variant="new" />
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}

          {/* Side-by-side JSON panels */}
          {!loading && (baseline || passedLive) && (
            <div className="comparison-json-panels">
              {/* Global expand/collapse */}
              <div className="comparison-json-controls">
                <button className="panel-action-btn" onClick={expandAll}>Expand all</button>
                <button className="panel-action-btn" onClick={collapseAll}>Collapse all</button>
              </div>

              {/* Baseline panel */}
              <section className="panel comparison-json-panel">
                <div className="panel-header">
                  <div className="panel-header-left">
                    <div className="panel-dot panel-dot--baseline" />
                    <h3>Golden Baseline</h3>
                  </div>
                  {baseline && (
                    <span className="panel-badge panel-badge--live">ARM</span>
                  )}
                </div>
                <div className="panel-body panel-body-json">
                  {baseline
                    ? <JsonTree key={JSON.stringify(baseline).slice(0,64)} ref={baselineTreeRef} data={baseline} />
                    : <div className="panel-empty"><p>No baseline stored</p></div>
                  }
                </div>
              </section>

              {/* Live state panel */}
              <section className="panel comparison-json-panel">
                <div className="panel-header">
                  <div className="panel-header-left">
                    <div className="panel-dot panel-dot--live" />
                    <h3>Live State</h3>
                  </div>
                  <span className="panel-badge panel-badge--live">ARM</span>
                </div>
                <div className="panel-body panel-body-json">
                  <JsonTree ref={liveTreeRef} data={normaliseState(passedLive)} />
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}