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
import MultiSelectDropdown from '../components/MultiSelectDropdown'
import NavBar from '../components/NavBar'
import ScheduleRemediationModal from '../components/ScheduleRemediationModal'
import { fetchBaseline, runCompare, remediateToBaseline, fetchAiExplanation, fetchAiRecommendation, uploadBaseline, createTicket, fetchResourceConfiguration, fetchComplianceImpact, fetchSuppressionRules, fetchCostEstimate } from '../services/api'
import { getControlsForPath } from '../utils/complianceMap'

// Shows monthly cost delta badge for SKU/tier/encryption drift rows
function CostDeltaBadge({ resourceType, location, fieldPath, oldValue, newValue }) {
  const [delta, setDelta] = React.useState(null)
  React.useEffect(() => {
    if (!oldValue || !newValue || String(oldValue) === String(newValue)) return
    fetchCostEstimate(resourceType, fieldPath, oldValue, newValue, location)
      .then(r => { if (r?.deltaPerMonth != null) setDelta(r) })
      .catch(() => {})
  }, [resourceType, location, fieldPath, oldValue, newValue])
  if (!delta?.deltaPerMonth) return null
  const positive = delta.deltaPerMonth > 0
  const color    = positive ? '#ef4444' : '#10b981'
  const sign     = positive ? '+' : ''
  return (
    <span title={delta.note || `Estimated monthly cost impact (${delta.referenceGB || 1024}GB reference)`}
      style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 3, marginLeft: 6,
        background: `${color}18`, color, border: `1px solid ${color}30`, whiteSpace: 'nowrap', cursor: 'help' }}>
      {sign}${Math.abs(delta.deltaPerMonth).toFixed(2)}/mo
    </span>
  )
}
import { useDashboard } from '../context/DashboardContext'
import { useViewMode } from '../context/ViewModeContext'
import AggregatedDriftView from '../components/AggregatedDriftView'
import ManualFixGuide from '../components/ManualFixGuide'
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
  // VM and general read-only fields that should never appear as drift
  const READONLY = ['vmId','timeCreated','instanceView','powerState','statuses','latestModelApplied',
    'resourceGuid','defaultSecurityRules','adminUsername','adminPassword','computerName',
    'disablePasswordAuthentication','ssh','provisionVMAgent','patchSettings','enableAutomaticUpdates','winRM']
  const strip = (obj, parentKey = '') => {
    if (Array.isArray(obj)) return obj.map(item => strip(item, parentKey))
    if (obj && typeof obj === 'object') return Object.fromEntries(
      Object.entries(obj)
        .filter(([k]) => !VOLATILE.includes(k) && !READONLY.includes(k))
        .filter(([k]) => !(parentKey === 'osDisk' && ['name','managedDisk'].includes(k)))
        .map(([k,v]) => [k, strip(v, k)])
    )
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
  const { subscriptionId: initSubId, resourceGroupId: initRgId, resourceId: initResId, resourceName, liveState: passedLive, scopes: stateScopes } = state
  const { subscription, resourceGroup, resource, configData, scopes: ctxScopes } = useDashboard()
  const passedScopes = stateScopes || (ctxScopes?.length ? ctxScopes : null)

  // Active scope — user can switch via dropdown when multiple scopes passed
  const [activeScopeIdx, setActiveScopeIdx] = useState(0)
  const multiScopes = passedScopes?.filter(s => s.resourceGroupId) || null
  const activeScope = multiScopes ? (multiScopes[activeScopeIdx] || multiScopes[0]) : null

  const subscriptionId  = activeScope?.subscriptionId  || initSubId
  const resourceGroupId = activeScope?.resourceGroupId || initRgId
  const resourceId      = activeScope?.resourceId      || initResId || null
  const effectiveId = resourceId || resourceGroupId
  const { viewMode } = useViewMode()
  const [remediationMode, setRemediationMode] = useState(false)
  const [driftViewMode, setDriftViewMode] = useState('individual') // 'individual' | 'aggregated'
  const [expandedCompareResource, setExpandedCompareResource] = useState(null)
  const user = (() => { try { return JSON.parse(sessionStorage.getItem('user') || '{}') } catch { return {} } })()

  // Live config — starts from navigation state, refreshed every 5 seconds
  const [currentLive, setCurrentLive] = useState(passedLive)

  // Poll live ARM config every 5 seconds — updates diff silently without loading screen
  useEffect(() => {
    if (!subscriptionId || !resourceGroupId) return
    const id = setInterval(async () => {
      try {
        const fresh = await fetchResourceConfiguration(subscriptionId, resourceGroupId, resourceId || null)
        if (fresh) setCurrentLive(fresh)
      } catch { /* non-fatal */ }
    }, 5000)
    return () => clearInterval(id)
  }, [subscriptionId, resourceGroupId, resourceId])

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

  // Feature 6: Schedule Remediation Modal
  const [showScheduleModal, setShowScheduleModal] = useState(false)
  const [scheduledConfirmation, setScheduledConfirmation] = useState(null)
  const [isPolicyCreated,   setIsPolicyCreated]   = useState(false)
  const [policiesCreated,   setPoliciesCreated]   = useState([])

  // Refs to the JsonTree components so we can call expandAll/collapseAll imperatively
  const baselineTreeRef = useRef(null)
  const liveTreeRef = useRef(null)
  const aiExplainedRef = useRef(false)  // prevents AI re-fetch on every 5s live refresh


  // Load remediation mode from org admin's preferences — polls every 10s
  useEffect(() => {
    const loadRemediationMode = () => {
      import('../services/authService').then(({ fetchOrgMembers }) => {
        fetchOrgMembers().then(data => {
          const members = data.members || data
          const admin = members.find(m => m.role === 'admin')
          if (admin) {
            import('../services/api').then(({ fetchUserPreferences }) => {
              fetchUserPreferences(admin.email || admin.userId).then(prefs => {
                if (prefs?.autoRemediate !== undefined) setRemediationMode(prefs.autoRemediate)
              }).catch(() => {})
            })
          }
        }).catch(() => {})
      })
    }
    loadRemediationMode()
    const interval = setInterval(loadRemediationMode, 10000)
    return () => clearInterval(interval)
  }, [])

  // On mount: call POST /api/compare (server-side diff with suppression rules applied)
  // Suppression rules stored in Azure Table Storage are applied before returning diffs
  useEffect(() => {
    // Reset on scope change
    setBaselineConfig(null); setFieldDifferences([]); setBaselineNotFound(false)
    setCurrentLive(null); aiExplainedRef.current = false; setAiDriftExplanation(null)
    setIsRemediating(false); setRemediationSucceeded(false); setRemediationError(null)
    setRemediationDiffSummary(null); setIsPolicyCreated(false); setShowScheduleModal(false)
    if (!subscriptionId || !resourceGroupId) { setIsLoadingBaseline(false); return }
    setIsLoadingBaseline(true)

    runCompare(subscriptionId, resourceGroupId, resourceId || null)
      .then(result => {
        if (!result) { setBaselineNotFound(true); return }

        // result.baselineState may be null if no baseline exists yet
        if (!result.baselineState) { setBaselineNotFound(true); return }

        setBaselineConfig(normaliseState(result.baselineState))
        if (result.liveState) setCurrentLive(result.liveState)
        const diffs = result.differences || []
        setFieldDifferences(diffs)
        setDriftSeverity(classifySeverity(diffs))

        if (diffs.length > 0 && !aiExplainedRef.current) {
          aiExplainedRef.current = true
          setIsAiLoading(true)
          fetchAiExplanation({
            resourceId, resourceGroup: resourceGroupId, subscriptionId,
            severity: classifySeverity(diffs), differences: diffs, changes: diffs,
          })
            .then(r => setAiDriftExplanation(r?.explanation || null))
            .catch(() => {})
            .finally(() => setIsAiLoading(false))
        }
      })
      .catch(() => setBaselineNotFound(true))
      .finally(() => setIsLoadingBaseline(false))
  }, [subscriptionId, resourceId, resourceGroupId, activeScopeIdx])

  // Recalculate diff client-side when live config updates (5s poll)
  useEffect(() => {
    if (!baselineConfig || !currentLive) return
    const diffs = formatDifferences(deepDiff(baselineConfig, normaliseState(currentLive)) || [])
    setFieldDifferences(diffs)
    setDriftSeverity(classifySeverity(diffs))
  }, [currentLive, baselineConfig])

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
      const strippedLiveForSummary = normaliseState(currentLive)
      setRemediationDiffSummary(formatDifferences(deepDiff(baselineConfig || {}, strippedLiveForSummary) || []))

      // All severities go through ticket approval system
      const result = await createTicket({
        subscriptionId, resourceGroupId, resourceId: effectiveId,
        severity: driftSeverity || 'medium',
        description: `Remediation requested for ${displayName}: ${fieldDifferences.length} change(s) detected`,
      })
      setRemediationSucceeded(true)
      setRemediationDiffSummary([{ path: 'Ticket', type: 'info', sentence: `Approval ticket created (${result.currentApprovals}/${result.requiredApprovals} approvals needed)` }])

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
          // Re-run server-side compare so suppression rules are applied to the new baseline
          const recompare = await runCompare(subscriptionId, resourceGroupId, resourceId || null).catch(() => null)
          if (recompare?.baselineState) {
            setBaselineConfig(normaliseState(recompare.baselineState))
            setFieldDifferences(recompare.differences || [])
            setDriftSeverity(classifySeverity(recompare.differences || []))
          }
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

  if (!subscriptionId) {
    return (
      <div className="cp-root">
        <NavBar user={user} subscription={subscription} resourceGroup={resourceGroup} resource={resource} configData={configData} />
        <div className="cp-empty-state" role="status">
          <span className="material-symbols-outlined" style={{ fontSize: 48, color: '#c2c7d0' }}>compare_arrows</span>
          <p>No comparison data available. Navigate here from the Drift Scanner or Dashboard.</p>
          <button className="cp-btn cp-btn--primary" onClick={() => navigate('/dashboard')}>← Go to Dashboard</button>
        </div>
      </div>
    )
  }

  return (
    <div className="cp-root">
      <NavBar user={user} subscription={subscription} resourceGroup={resourceGroup} resource={resource} configData={configData} />

      <main className="cp-main" id="main-content" role="main">
        {/* Page header */}
        {/* Multi-scope dropdown */}
        {multiScopes && multiScopes.length > 1 && (
          <div style={{ padding: '8px 16px', borderBottom: '1px solid rgba(0,0,0,0.06)' }}>
            <MultiSelectDropdown
              options={multiScopes.map((s, i) => ({
                value: i,
                label: s.resourceId ? s.resourceId.split('/').pop() : `${s.resourceGroupId} (all resources)`
              }))}
              selected={activeScopeIdx !== null ? [activeScopeIdx] : []}
              onChange={val => {
                if(val.length) {
                  setActiveScopeIdx(Number(val[0]))
                  aiExplainedRef.current = false
                }
              }}
              placeholder="Select a scope..."
              singleSelect={true}
            />
          </div>
        )}
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
            <label className="cp-btn cp-btn--secondary" style={{ cursor: 'pointer' }}>
              <input type="file" accept=".json" onChange={handleUpload} style={{ display: 'none' }} disabled={isUploadingBaseline} />
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>upload</span>
              {isUploadingBaseline ? 'Uploading...' : 'Upload'}
            </label>
            {/* Feature 4: Export Baseline as ARM Template */}
            <button className="cp-btn cp-btn--secondary" onClick={() => {
              const blob = new Blob([JSON.stringify(baselineConfig || {}, null, 2)], { type: 'application/json' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = `${displayName}-baseline.json`
              a.click()
            }} disabled={!baselineConfig}>
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>download</span> Export
            </button>
            {fieldDifferences.length > 0 && !baselineNotFound && (
              <>
                {remediationMode ? (
                <button className={`cp-btn ${driftSeverity === 'low' ? 'cp-btn--green' : 'cp-btn--primary'}`} onClick={handleRemediate} disabled={isRemediating || remediationSucceeded}>
                  {isRemediating ? <><div className="cp-spinner" />{driftSeverity === 'low' ? 'Applying...' : 'Sending...'}</> :
                   remediationSucceeded ? (driftSeverity === 'low' ? '✓ Remediated!' : '✓ Request Sent!') :
                   driftSeverity === 'low' ? 'Apply Fix Now' : 'Request Approval'}
                </button>
                ) : (
                <span className="cp-btn cp-btn--secondary" style={{ cursor: "default", opacity: 0.7 }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 16 }}>menu_book</span> Read-Only Mode
                </span>
                )}
                {/* Feature 6: Schedule Remediation */}
                {driftSeverity !== 'low' && !remediationSucceeded && (
                  <button className="cp-btn cp-btn--secondary" onClick={() => setShowScheduleModal(true)}>
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>schedule</span> Schedule Fix
                  </button>
                )}
              </>
            )}
          </div>
        </header>

        {/* Alerts */}
        {baselineUploadMessage && <div className={`cp-alert cp-alert--${baselineUploadMessage.ok ? 'success' : 'error'}`} role="alert">{baselineUploadMessage.text}</div>}
        {remediationError && <div className="cp-alert cp-alert--error" role="alert">Failed to remediate: {remediationError}</div>}
        {remediationSucceeded && remediationDiffSummary !== null && (
          <div className="cp-alert cp-alert--success" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <strong>{driftSeverity === 'low' ? '✓ Remediation applied.' : '✓ Approval request sent.'}</strong>
              {remediationDiffSummary.length > 0 && <span> {remediationDiffSummary.length} field change(s) queued.</span>}
            </div>
            {/* Feature 8: Policy as Code Enforcement */}
            {policiesCreated.length > 0 ? (
              <div style={{ fontSize: 12, color: '#10b981' }}>
                <span className="material-symbols-outlined" style={{ fontSize: 14, verticalAlign: 'middle' }}>policy</span>
                {' '}{policiesCreated.length} policy assignment{policiesCreated.length !== 1 ? 's' : ''} created to prevent recurrence
              </div>
            ) : (
              <button className="cp-btn cp-btn--primary" disabled={isPolicyCreated || driftSeverity !== 'low'} title={driftSeverity !== 'low' ? 'Policy enforcement runs automatically after approval' : ''}>
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>policy</span>
                {isPolicyCreated ? 'Policy Created' : 'Policy Enforcement Active'}
              </button>
            )}
          </div>
        )}

        {/* AI Manual Fix Guide — shown when remediation mode is OFF */}
        {!remediationMode && fieldDifferences.length > 0 && baselineConfig && (
          <ManualFixGuide resourceId={resourceId} resourceType={currentLive?.type} displayName={displayName} differences={fieldDifferences} />
        )}

        {/* AI cards — Dev view only (CTO shows AI inline above) */}
        {viewMode === 'dev' && (isAiLoading || aiDriftExplanation) && (
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
        {isLoadingBaseline && <div className="cp-loading" role="status" aria-live="polite"><div className="cp-loading-ring" aria-hidden="true" /><span>Loading golden baseline...</span></div>}

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

        {/* View mode toggle: Individual / Aggregated */}
        {!isLoadingBaseline && baselineConfig && fieldDifferences.length > 0 && (
          <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
            <button onClick={() => setDriftViewMode('individual')}
              style={{ padding: '5px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                background: driftViewMode === 'individual' ? '#0060a9' : 'rgba(255,255,255,0.04)', color: driftViewMode === 'individual' ? '#fff' : 'rgba(255,255,255,0.5)' }}>
              Individual Changes
            </button>
            <button onClick={() => setDriftViewMode('aggregated')}
              style={{ padding: '5px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600,
                background: driftViewMode === 'aggregated' ? '#0060a9' : 'rgba(255,255,255,0.04)', color: driftViewMode === 'aggregated' ? '#fff' : 'rgba(255,255,255,0.5)' }}>
              Aggregated + AI Recommendations
            </button>
          </div>
        )}

        {/* Aggregated view with AI recommendations */}
        {driftViewMode === 'aggregated' && !isLoadingBaseline && baselineConfig && fieldDifferences.length > 0 && (
          <div className="cp-card">
            <AggregatedDriftView
              subscriptionId={subscriptionId}
              resourceGroupId={resourceGroupId}
              resourceId={resourceId}
              resourceType={currentLive?.type || ''}
              fieldDifferences={fieldDifferences}
            />
          </div>
        )}

        {/* Changes summary — Dev view shows detailed diff table, CTO view handled above */}
        {driftViewMode === 'individual' && viewMode === 'dev' && !isLoadingBaseline && baselineConfig && (
          <div className="cp-card">
            <div className="cp-card-header">
              <span className="material-symbols-outlined" style={{ color: '#0060a9' }}>info</span>
              <h3>{fieldDifferences.length === 0 ? 'In sync with baseline' : `${fieldDifferences.length} change(s) detected`}</h3>
              {fieldDifferences.length === 0 && <span className="cp-sync-badge">✓ No drift</span>}
            </div>
            {fieldDifferences.length > 0 && (
              <div className="cp-changes-list">
                {fieldDifferences.map((diffItem, diffIndex) => {
                  const controls = getControlsForPath(diffItem.path)
                  return (
                  <div key={diffIndex} className={`cp-change cp-change--${diffItem.type}`}>
                    <div className="cp-change-header">
                      <span className={`cp-change-badge cp-change-badge--${diffItem.type}`}>{diffItem.label}</span>
                      <code className="cp-change-path">{diffItem.path}</code>
                      {/sku|tier|accesstier|replication|capacity|keysource|encryption|vmsize|hardwareprofile/i.test(diffItem.path) && diffItem.oldValue !== undefined && diffItem.newValue !== undefined && (
                        <CostDeltaBadge
                          resourceType={currentLive?.type || ''}
                          location={currentLive?.location || 'westus2'}
                          fieldPath={diffItem.path}
                          oldValue={diffItem.oldValue}
                          newValue={diffItem.newValue}
                        />
                      )}
                      {controls.length > 0 && (
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginLeft: 'auto' }}>
                          {controls.map((c, ci) => (
                            <span key={ci} title={c.title} style={{
                              fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 3,
                              background: 'rgba(202,138,4,0.12)', color: '#ca8a04',
                              border: '1px solid rgba(202,138,4,0.25)', whiteSpace: 'nowrap',
                            }}>{c.fw}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="cp-change-values">
                      {diffItem.oldValue !== undefined && <ValueChip value={diffItem.oldValue} variant="old" />}
                      {diffItem.oldValue !== undefined && diffItem.newValue !== undefined && <span className="cp-arrow">→</span>}
                      {diffItem.newValue !== undefined && <ValueChip value={diffItem.newValue} variant="new" />}
                    </div>
                  </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* CTO view — AI-powered plain English summary */}
        {viewMode === 'cto' && !isLoadingBaseline && (
          <div className="cp-card" style={{ marginTop: 16 }}>
            <div className="cp-card-header">
              <span className="material-symbols-outlined" style={{ color: '#0060a9' }}>summarize</span>
              <h3>Executive Summary</h3>
              {driftSeverity && <span className="cp-severity-badge" style={{ background: `${SEV_COLOR[driftSeverity]}18`, color: SEV_COLOR[driftSeverity], border: `1px solid ${SEV_COLOR[driftSeverity]}40`, marginLeft: 'auto' }}>{driftSeverity.toUpperCase()}</span>}
            </div>
            <div style={{ padding: '16px 20px', fontSize: 14, lineHeight: 1.8, color: 'var(--text-secondary)' }}>
              {baselineNotFound && <p>No golden baseline has been set for <strong>{displayName}</strong>. Promote the current state to establish a reference point.</p>}
              {baselineConfig && fieldDifferences.length === 0 && (
                <p style={{ color: '#10b981', fontSize: 15 }}>✓ <strong>{displayName}</strong> is fully compliant — no configuration drift detected.</p>
              )}
              {baselineConfig && fieldDifferences.length > 0 && (
                <>
                  {isAiLoading && <p style={{ color: '#60a5fa' }}>⏳ Generating AI analysis with Azure OpenAI...</p>}
                  {aiDriftExplanation && <p style={{ fontSize: 15, color: 'var(--text-primary)' }}>{aiDriftExplanation}</p>}
                  {!isAiLoading && !aiDriftExplanation && <p><strong>{fieldDifferences.length}</strong> configuration change{fieldDifferences.length !== 1 ? 's' : ''} detected on <strong>{displayName}</strong>.</p>}
                  <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {fieldDifferences.map((diff, index) => (
                      <div key={index} style={{ padding: '10px 14px', background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: diff.type === 'removed' ? '#ef4444' : diff.type === 'added' ? '#10b981' : '#f59e0b' }} />
                        <span style={{ flex: 1 }}>
                          <strong>{diff.type === 'removed' ? 'Removed' : diff.type === 'added' ? 'Added' : 'Modified'}</strong>{' '}
                          {diff.path?.toLowerCase().includes('tag') ? (
                            <span>tag: <strong>{diff.path?.split(' → ').pop()}</strong>{diff.oldValue !== undefined ? `: ${String(diff.oldValue).slice(0,30)}` : ''}</span>
                          ) : (
                            <span>{diff.path?.split(' → ').pop() || diff.path}</span>
                          )}
                          {!diff.path?.toLowerCase().includes('tag') && diff.oldValue !== undefined && diff.newValue !== undefined && (
                            <span style={{ color: '#6b7280' }}>{' '}({String(diff.oldValue).slice(0,20)} → {String(diff.newValue).slice(0,20)})</span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* RG-level resource details — CTO view */}
        {viewMode === 'cto' && currentLive?.resources && (
          <div className="cp-card" style={{ marginTop: 16 }}>
            <div className="cp-card-header">
              <span className="material-symbols-outlined" style={{ color: '#0060a9' }}>dns</span>
              <h3>Resources ({currentLive.resources.length})</h3>
            </div>
            <div style={{ padding: '12px 16px' }}>
              {currentLive.resources.map((resource, index) => {
                const resProps = resource.properties || {}
                const resSku = resource.sku || {}
                const isExpanded = expandedCompareResource === index
                return (
                  <div key={index} style={{ borderBottom: '1px solid var(--border-subtle)', marginBottom: 4 }}>
                    <div onClick={() => setExpandedCompareResource(isExpanded ? null : index)}
                      style={{ cursor: 'pointer', padding: '8px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ color: '#1995ff', fontSize: 11, transition: 'transform 0.2s', transform: isExpanded ? 'rotate(90deg)' : '', flexShrink: 0 }}>▶</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{resource.name || resource.id?.split('/').pop()}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{(resource.type || '').split('/').pop()}</div>
                      </div>
                      <span style={{ fontSize: 11, color: 'var(--text-secondary)', flexShrink: 0 }}>{resource.location || ''}</span>
                    </div>
                    {isExpanded && (
                      <div style={{ padding: '6px 12px 12px 20px', fontSize: 12 }}>
                        {resSku.name && <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}><span style={{ color: 'var(--text-muted)', fontSize: 11 }}>SKU</span><span style={{ color: 'var(--text-primary)', fontSize: 12 }}>{resSku.name}{resSku.tier ? ` / ${resSku.tier}` : ''}</span></div>}
                        {resource.kind && <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}><span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Kind</span><span style={{ color: 'var(--text-primary)', fontSize: 12 }}>{resource.kind}</span></div>}
                        {Object.entries(resProps).filter(([k]) => k !== 'provisioningState' && k !== 'creationTime').map(([key, value]) => (
                          <div key={key} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                            <span style={{ color: 'var(--text-muted)', fontSize: 11, flexShrink: 0, marginRight: 12 }}>{key}</span>
                            <span style={{ color: 'var(--text-primary)', fontSize: 12, maxWidth: '60%', textAlign: 'right', wordBreak: 'break-all' }}>
                              {typeof value === 'boolean' ? (value ? '✅' : '❌') : typeof value === 'object' ? JSON.stringify(value).slice(0, 80) : String(value).slice(0, 80)}
                            </span>
                          </div>
                        ))}
                        {resource.tags && Object.keys(resource.tags).length > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}><span style={{ color: 'var(--text-muted)', fontSize: 11 }}>Tags</span><span style={{ color: 'var(--text-primary)', fontSize: 12 }}>{Object.entries(resource.tags).map(([k,v]) => `${k}=${v}`).join(', ')}</span></div>}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* JSON panels — Dev view only */}
        {viewMode === 'dev' && !isLoadingBaseline && (baselineConfig || currentLive) && (
          <div className="cp-json-row">
            <div className="cp-json-panel">
              <div className="cp-json-panel-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="cp-dot cp-dot--baseline" />
                  <h3>Golden Baseline</h3>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="cp-toolbar-btn" onClick={expandAll} aria-label="Expand all nodes"><span className="material-symbols-outlined">unfold_more</span></button>
                  <button className="cp-toolbar-btn" onClick={collapseAll} aria-label="Collapse all nodes"><span className="material-symbols-outlined">unfold_less</span></button>
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
                <JsonTree ref={liveTreeRef} data={normaliseState(currentLive)} />
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Feature 6: Schedule Remediation Modal */}
      {showScheduleModal && (
        <ScheduleRemediationModal
          subscriptionId={subscriptionId}
          resourceGroupId={resourceGroupId}
          resourceId={resourceId}
          severity={driftSeverity}
          onClose={() => setShowScheduleModal(false)}
          onScheduled={schedule => {
            setScheduledConfirmation(schedule)
            setRemediationSucceeded(true)
          }}
        />
      )}
    </div>
  )
}
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

