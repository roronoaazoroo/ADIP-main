// FILE: src/pages/ComparisonPage.jsx
// ROLE: Shows baseline vs live ARM config side-by-side with field-level diff and remediation

// What this page does:
//   - On load: fetches the golden baseline blob and policy compliance in parallel
//   - Strips volatile fields (etag, provisioningState) from both configs before diffing
//   - Runs deepDiff(baseline, live) to get field-level changes
//   - Classifies severity: Critical / High / Medium / Low
//   - Calls Azure OpenAI (non-blocking) for plain-English explanation
//   - Remediate button: Low = immediate ARM PUT, Medium/High/Critical = approval email
//   - Upload Baseline: accepts raw ARM config or ARM template export (.json)

// Receives data via React Router location.state (set by DashboardHome or DriftScanner)

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

  // The stripped golden baseline config fetched from 'baselines' blob storage
  const [baselineConfig, setBaselineConfig] = useState(null)

  // Array of field-level differences between baseline and live config
  // Each item: { path, type, label, oldValue, newValue }
  const [fieldDifferences, setFieldDifferences] = useState([])

  // Drift severity level: 'critical' | 'high' | 'medium' | 'low' | null
  const [driftSeverity, setDriftSeverity] = useState(null)

  // Whether the baseline is currently being fetched from blob storage
  const [isLoadingBaseline, setIsLoadingBaseline] = useState(false)

  // True if no baseline blob exists for this resource yet
  const [baselineNotFound, setBaselineNotFound] = useState(false)

  // Whether a remediation ARM PUT or approval request is in progress
  const [isRemediating, setIsRemediating] = useState(false)

  // True after a successful remediation or approval request
  const [remediationSucceeded, setRemediationSucceeded] = useState(false)

  // Error message if remediation fails
  const [remediationError, setRemediationError] = useState(null)

  // The diff shown in the success banner after remediation
  const [remediationDiffSummary, setRemediationDiffSummary] = useState(null)

  // Azure Policy compliance result for this resource
  const [policyComplianceData, setPolicyComplianceData] = useState(null)

  // Plain-English explanation from Azure OpenAI (loaded async after diff)
  const [aiDriftExplanation, setAiDriftExplanation] = useState(null)

  // Remediation recommendation from Azure OpenAI (loaded when user clicks Remediate)
  const [aiRemediationRecommendation, setAiRemediationRecommendation] = useState(null)

  // Whether the AI explanation is currently being fetched
  const [isAiLoading, setIsAiLoading] = useState(false)

  // Whether a baseline file upload is in progress
  const [isUploadingBaseline, setIsUploadingBaseline] = useState(false)

  // Success/error message shown after a baseline upload attempt
  const [baselineUploadMessage, setBaselineUploadMessage] = useState(null)

  // Refs to the JsonTree components so we can call expandAll/collapseAll imperatively
  const baselineTreeRef = useRef(null)
  const liveTreeRef = useRef(null)

  // On mount: fetch the golden baseline and policy compliance in parallel
  // Then compute the diff between baseline and the live config passed via navigation state
  useEffect(() => {
    if (!subscriptionId) return
    setIsLoadingBaseline(true)

    // Fetch policy compliance in the background (non-blocking)
    fetchPolicyCompliance(subscriptionId, resourceGroupId, resourceId)
      .then(setPolicyComplianceData).catch(() => {})

    // Fetch the golden baseline blob for this resource
    fetchBaseline(subscriptionId, effectiveId).then(baselineDocument => {
      if (baselineDocument?.resourceState) {
        // Strip volatile fields before comparing so etag/provisioningState don't show as drift
        const strippedBaseline = normaliseState(baselineDocument.resourceState)
        const strippedLive     = normaliseState(passedLive)
        setBaselineConfig(strippedBaseline)

        // Run deep field-level diff
        const rawDiffResult      = deepDiff(strippedBaseline, strippedLive) || []
        const formattedDiffItems = formatDifferences(rawDiffResult)
        setFieldDifferences(formattedDiffItems)
        setDriftSeverity(classifySeverity(formattedDiffItems))

        // If drift was found, fetch AI explanation in the background
        if (formattedDiffItems.length > 0) {
          setIsAiLoading(true)
          fetchAiExplanation({
            resourceId,
            resourceGroup: resourceGroupId,
            subscriptionId,
            severity: classifySeverity(formattedDiffItems),
            differences: formattedDiffItems,
            changes:     formattedDiffItems,
          })
            .then(aiResponse => setAiDriftExplanation(aiResponse?.explanation || null))
            .catch(() => {})
            .finally(() => setIsAiLoading(false))
        }
      } else {
        // No baseline stored for this resource
        setBaselineNotFound(true)
      }
    }).catch(() => setBaselineNotFound(true)).finally(() => setIsLoadingBaseline(false))
  }, [subscriptionId, resourceId])

  // handleRemediate — called when the user clicks 'Apply Fix Now' or 'Request Approval'
  // Low severity: immediately calls ARM PUT via /api/remediate to revert to baseline
  // Medium/High/Critical: sends an approval email via /api/remediate-request
  //   → Logic App → sendAlert Function → ACS email with Approve/Reject links
  const handleRemediate = async () => {
    setIsRemediating(true)
    setRemediationError(null)
    setRemediationDiffSummary(null)

    // Fetch AI recommendation in the background (shown after remediation)
    fetchAiRecommendation({
      resourceId,
      resourceGroup: resourceGroupId,
      subscriptionId,
      severity: driftSeverity,
      differences: fieldDifferences,
      changes: fieldDifferences,
    }).then(aiResponse => setAiRemediationRecommendation(aiResponse?.recommendation || null)).catch(() => {})

    try {
      // Compute the diff that will be shown in the success banner
      const strippedLiveForSummary = normaliseState(passedLive)
      setRemediationDiffSummary(formatDifferences(deepDiff(baselineConfig || {}, strippedLiveForSummary) || []))

      if (driftSeverity === 'low') {
        // Low severity: apply immediately via ARM PUT (no approval needed)
        await remediateToBaseline(subscriptionId, resourceGroupId, effectiveId)
      } else {
        // Medium/High/Critical: send approval email to admin
        const loggedInUser = (() => { try { return JSON.parse(sessionStorage.getItem('user') || '{}') } catch { return {} } })()
        await requestRemediation({
          subscriptionId,
          resourceGroupId,
          resourceId:  effectiveId,
          differences: fieldDifferences,
          changes:     fieldDifferences,
          severity:    driftSeverity,
          caller:      loggedInUser.name || 'Dashboard User',
        })
      }
      setRemediationSucceeded(true)
    } catch (remediationErr) {
      setRemediationError(remediationErr.message)
    } finally {
      setIsRemediating(false)
    }
  }

  // handleUpload — called when the user selects a .json file to use as the new baseline
  // Accepts: raw ARM config JSON, or an ARM template export (extracts resources[0])
  // After upload: re-fetches the baseline and recomputes the diff
  const handleUpload = (fileInputEvent) => {
    const selectedFile = fileInputEvent.target.files?.[0]
    if (!selectedFile) return
    if (!selectedFile.name.endsWith('.json')) {
      setBaselineUploadMessage({ ok: false, text: 'Only .json files are accepted.' })
      return
    }

    const fileReader = new FileReader()
    fileReader.onload = async (readEvent) => {
      let parsedBaselineJson
      try {
        parsedBaselineJson = JSON.parse(readEvent.target.result)
      } catch {
        setBaselineUploadMessage({ ok: false, text: 'Invalid JSON.' })
        return
      }

      // If the file is an ARM template export, extract the first resource from resources[]
      if (parsedBaselineJson.$schema?.includes('deploymentTemplate') && Array.isArray(parsedBaselineJson.resources)) {
        parsedBaselineJson = parsedBaselineJson.resources[0]
        if (!parsedBaselineJson) {
          setBaselineUploadMessage({ ok: false, text: 'ARM template has no resources.' })
          return
        }
      }

      setIsUploadingBaseline(true)
      setBaselineUploadMessage(null)
      try {
        // Upload the new baseline to blob storage
        await uploadBaseline(subscriptionId, resourceGroupId, effectiveId, parsedBaselineJson)

        // Re-fetch the baseline and recompute the diff
        const updatedBaselineDocument = await fetchBaseline(subscriptionId, effectiveId)
        if (updatedBaselineDocument?.resourceState) {
          const newStrippedBaseline = normaliseState(updatedBaselineDocument.resourceState)
          const strippedLive        = normaliseState(passedLive)
          const newDiffItems        = formatDifferences(deepDiff(newStrippedBaseline, strippedLive) || [])
          setBaselineConfig(newStrippedBaseline)
          setFieldDifferences(newDiffItems)
          setDriftSeverity(classifySeverity(newDiffItems))
          setBaselineNotFound(false)
          setBaselineUploadMessage({ ok: true, text: 'Baseline uploaded and applied.' })
        } else {
          setBaselineNotFound(true)
          setBaselineUploadMessage({ ok: false, text: 'Upload succeeded but baseline not found.' })
        }
      } catch (uploadError) {
        setBaselineUploadMessage({ ok: false, text: `Upload failed: ${uploadError.message}` })
      } finally {
        setIsUploadingBaseline(false)
        fileInputEvent.target.value = ''  // reset file input so same file can be re-selected
      }
    }
    fileReader.readAsText(selectedFile)
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
            {driftSeverity && <span className="cp-severity-badge" style={{ background: `${SEV_COLOR[driftSeverity]}18`, color: SEV_COLOR[driftSeverity], border: `1px solid ${SEV_COLOR[driftSeverity]}40` }}>{driftSeverity.toUpperCase()}</span>}
            {policyComplianceData?.nonCompliant > 0 && <span className="cp-severity-badge" style={{ background: '#dc262618', color: '#dc2626', border: '1px solid #dc262640' }}>POLICY: {policyComplianceData.nonCompliant} VIOLATION(S)</span>}
            <label className="cp-btn cp-btn--secondary" style={{ cursor: 'pointer' }}>
              <input type="file" accept=".json" onChange={handleUpload} style={{ display: 'none' }} disabled={isUploadingBaseline} />
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>upload</span>
              {isUploadingBaseline ? 'Uploading...' : 'Upload Baseline'}
            </label>
            {fieldDifferences.length > 0 && !baselineNotFound && (
              <button className={`cp-btn ${driftSeverity === 'low' ? 'cp-btn--green' : 'cp-btn--primary'}`} onClick={handleRemediate} disabled={isRemediating || remediationSucceeded}>
                {isRemediating ? <><div className="cp-spinner" />{driftSeverity === 'low' ? 'Applying...' : 'Sending...'}</> :
                 remediationSucceeded ? (driftSeverity === 'low' ? '✓ Remediated!' : '✓ Request Sent!') :
                 driftSeverity === 'low' ? 'Apply Fix Now' : 'Request Approval'}
              </button>
            )}
          </div>
        </header>

        {/* Alerts */}
        {baselineUploadMessage && <div className={`cp-alert cp-alert--${baselineUploadMessage.ok ? 'success' : 'error'}`}>{baselineUploadMessage.text}</div>}
        {remediationError && <div className="cp-alert cp-alert--error">Failed to remediate: {remediationError}</div>}
        {remediationSucceeded && remediationDiffSummary !== null && (
          <div className="cp-alert cp-alert--success">
            <strong>{driftSeverity === 'low' ? '✓ Remediation applied.' : '✓ Approval request sent.'}</strong>
            {remediationDiffSummary.length > 0 && <span> {remediationDiffSummary.length} field change(s) queued.</span>}
          </div>
        )}

        {/* AI cards */}
        {(isAiLoading || aiDriftExplanation) && (
          <div className="cp-ai-card cp-ai-card--blue">
            <span className="material-symbols-outlined">smart_toy</span>
            <div>
              <div className="cp-ai-label">AI Security Analysis</div>
              <div className="cp-ai-text">{isAiLoading ? 'Analysing drift with Azure OpenAI...' : aiDriftExplanation}</div>
            </div>
          </div>
        )}
        {aiRemediationRecommendation && (
          <div className="cp-ai-card cp-ai-card--green">
            <span className="material-symbols-outlined">lightbulb</span>
            <div>
              <div className="cp-ai-label">AI Remediation Recommendation</div>
              <div className="cp-ai-text">{aiRemediationRecommendation}</div>
            </div>
          </div>
        )}

        {/* Loading */}
        {isLoadingBaseline && <div className="cp-loading"><div className="cp-loading-ring" /><span>Loading golden baseline...</span></div>}

        {/* No baseline */}
        {!isLoadingBaseline && baselineNotFound && (
          <div className="cp-card cp-card--center">
            <span className="material-symbols-outlined" style={{ fontSize: 48, color: '#c2c7d0' }}>layers</span>
            <p>No golden baseline found for <strong>{displayName}</strong>.</p>
            <button className="cp-btn cp-btn--primary" onClick={handleRemediate} disabled={isRemediating || remediationSucceeded}>
              {isRemediating ? 'Seeding...' : remediationSucceeded ? '✓ Done!' : 'Promote Current State as Baseline'}
            </button>
          </div>
        )}

        {/* Changes summary */}
        {!isLoadingBaseline && baselineConfig && (
          <div className="cp-card">
            <div className="cp-card-header">
              <span className="material-symbols-outlined" style={{ color: '#0060a9' }}>info</span>
              <h3>{fieldDifferences.length === 0 ? 'In sync with baseline' : `${fieldDifferences.length} change(s) detected`}</h3>
              {fieldDifferences.length === 0 && <span className="cp-sync-badge">✓ No drift</span>}
            </div>
            {fieldDifferences.length > 0 && (
              <div className="cp-changes-list">
                {fieldDifferences.map((diffItem, diffIndex) => (
                  <div key={diffIndex} className={`cp-change cp-change--${diffItem.type}`}>
                    <div className="cp-change-header">
                      <span className={`cp-change-badge cp-change-badge--${diffItem.type}`}>{diffItem.label}</span>
                      <code className="cp-change-path">{diffItem.path}</code>
                    </div>
                    <div className="cp-change-values">
                      {diffItem.oldValue !== undefined && <ValueChip value={diffItem.oldValue} variant="old" />}
                      {diffItem.oldValue !== undefined && diffItem.newValue !== undefined && <span className="cp-arrow">→</span>}
                      {diffItem.newValue !== undefined && <ValueChip value={diffItem.newValue} variant="new" />}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* JSON panels */}
        {!isLoadingBaseline && (baselineConfig || passedLive) && (
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
                {baselineConfig ? <JsonTree ref={baselineTreeRef} data={baselineConfig} /> : <div className="cp-json-empty">No baseline stored</div>}
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
