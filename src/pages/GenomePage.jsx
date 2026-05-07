// FILE: src/pages/GenomePage.jsx
// ROLE: Versioned snapshot history for a resource — save, promote, rollback, delete

// What this page does:
//   - Loads all snapshots for the selected resource from GET /api/genome
//     (reads 'baseline-genome' blob container via 'genomeIndex' Table index)
//   - Save Snapshot: calls POST /api/genome/save — fetches live ARM config and stores it
//   - Set as Baseline: calls POST /api/genome/promote — copies snapshot to 'baselines' blob
//   - Rollback: calls POST /api/genome/rollback — ARM PUT to revert resource to snapshot state
//     Rollback button is disabled after use (rolledBackAt persisted in genomeIndex Table)
//   - Delete: calls POST /api/genome/delete — removes blob and Table index row
//   - Clicking a snapshot shows its full ARM config JSON in the right panel

// Receives resource identifiers via React Router location.state

import React, { useState, useEffect, useCallback } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import JsonTree from '../components/JsonTree'
import MultiSelectDropdown from '../components/MultiSelectDropdown'
import NavBar from '../components/NavBar'
import GenomeHistory from '../components/GenomeHistory'
import { useDashboard } from '../context/DashboardContext'
import { fetchGenomeSnapshots, saveGenomeSnapshot, promoteGenomeSnapshot, rollbackToSnapshot, deleteGenomeSnapshot, fetchResourceConfiguration, analyzeRecovery, executeRecovery } from '../services/api'
import './GenomePage.css'

// Strips volatile fields for comparison — same keys as ComparisonPage normaliseState
function stripForCompare(obj) {
  if (!obj) return {}
  const SKIP = ['etag','provisioningState','changedTime','createdTime','lastModifiedAt',
    'vmId','timeCreated','instanceView','resourceGuid','adminUsername','disablePasswordAuthentication','ssh',
    '_childConfig']  // child resources change independently, not part of resource config
  const strip = (o, parent = '') => {
    if (Array.isArray(o)) return o.map(i => strip(i, parent))
    if (o && typeof o === 'object') return Object.fromEntries(
      Object.entries(o)
        .filter(([k]) => !SKIP.includes(k))
        .filter(([k]) => !(parent === 'osDisk' && ['name','managedDisk'].includes(k)))
        .map(([k,v]) => [k, strip(v, k)])
    )
    return o
  }
  return strip(JSON.parse(JSON.stringify(obj)))
}

// Returns true if two configs are functionally identical (ignoring volatile fields)
function configsMatch(a, b) {
  if (!a || !b) return false
  return JSON.stringify(stripForCompare(a)) === JSON.stringify(stripForCompare(b))
}

export default function GenomePage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { subscriptionId: initSubId, resourceGroupId: initRgId, resourceId: initResId, resourceName, scopes: stateScopes } = location.state ?? {}
  const passedScopes = stateScopes || (ctxScopes?.length ? ctxScopes : null)

  const [activeScopeIdx, setActiveScopeIdx] = useState(0)
  const multiScopes = passedScopes?.filter(s => s.resourceGroupId) || null
  const activeScope = multiScopes ? (multiScopes[activeScopeIdx] || multiScopes[0]) : null

  const subscriptionId  = activeScope?.subscriptionId  || initSubId
  const resourceGroupId = activeScope?.resourceGroupId || initRgId
  const resourceId      = activeScope?.resourceId      || initResId || null
  const { subscription, resourceGroup, resource, configData, scopes: ctxScopes } = useDashboard()
  const [liveConfig, setLiveConfig] = React.useState(configData)

  // Fetch fresh live config on mount (in case configData is stale or null)
  useEffect(() => {
    if (!subscriptionId || !(resourceId || resourceGroupId)) return
    fetchResourceConfiguration(subscriptionId, resourceGroupId, resourceId)
      .then(fresh => { if (fresh) setLiveConfig(fresh) })
      .catch(() => {})
  }, [subscriptionId, resourceGroupId, resourceId])
  const user = (() => { try { return JSON.parse(sessionStorage.getItem('user') || '{}') } catch { return {} } })()

  // List of all snapshots for this resource, sorted newest-first
  // Each snapshot: { _blobKey, savedAt, label, resourceState, rolledBackAt }
  const [snapshotList,        setSnapshotList]        = useState([])

  // Whether the snapshot list is currently being fetched
  const [isLoadingSnapshots,  setIsLoadingSnapshots]  = useState(false)

  // The snapshot currently selected in the timeline (shown in the JSON viewer on the right)
  const [selectedSnapshot,    setSelectedSnapshot]    = useState(null)

  // The text typed in the snapshot label input field
  const [snapshotLabelInput,  setSnapshotLabelInput]  = useState('')

  // Whether a new snapshot is currently being saved
  const [isSavingSnapshot,    setIsSavingSnapshot]    = useState(false)

  // Success or error message shown after any action (save/promote/rollback/delete)
  // Format: { ok: boolean, text: string }
  const [actionFeedbackMessage, setActionFeedbackMessage] = useState(null)

  // Active tab: 'snapshots' (timeline) or 'history' (rollback audit trail)
  const [activeTab, setActiveTab] = useState('snapshots')

  // The _blobKey of the snapshot currently being acted on (promote/rollback/delete)
  // Used to show '...' on the button and disable all buttons for that snapshot
  const [activeActionBlobKey, setActiveActionBlobKey] = useState(null)
  const [calendarMonth, setCalendarMonth] = useState(new Date())
  const [selectedDate, setSelectedDate] = useState(null)

  // Fetches all snapshots for this resource from GET /api/genome
  // Called on mount and after every save/rollback/delete action
  const loadSnapshots = useCallback(async () => {
    if (!subscriptionId) return
    setIsLoadingSnapshots(true)
    try {
      const fetchedSnapshots = await fetchGenomeSnapshots(subscriptionId, resourceId || resourceGroupId)
      setSnapshotList(fetchedSnapshots || [])
    } catch (fetchError) {
      setActionFeedbackMessage({ ok: false, text: fetchError.message })
    } finally {
      setIsLoadingSnapshots(false)
    }
  }, [subscriptionId, resourceId])

  useEffect(() => { loadSnapshots() }, [loadSnapshots])

  // Saves the current live ARM config as a new snapshot
  // Calls POST /api/genome/save → fetches live config → writes to 'baseline-genome' blob
  const handleSave = async () => {
    setIsSavingSnapshot(true)
    setActionFeedbackMessage(null)
    try {
      await saveGenomeSnapshot(subscriptionId, resourceGroupId, resourceId, snapshotLabelInput || 'manual snapshot')
      setSnapshotLabelInput('')
      setActionFeedbackMessage({ ok: true, text: 'Snapshot saved.' })
      loadSnapshots()  // refresh the timeline
    } catch (saveError) {
      setActionFeedbackMessage({ ok: false, text: saveError.message })
    } finally {
      setIsSavingSnapshot(false)
    }
  }

  // Promotes a snapshot to the golden baseline
  // Calls POST /api/genome/promote → copies snapshot resourceState to 'baselines' blob
  // After this, ComparisonPage will diff against this snapshot's config
  const handlePromote = async (snapshotToPromote) => {
    setActiveActionBlobKey(snapshotToPromote._blobKey)
    setActionFeedbackMessage(null)
    try {
      await promoteGenomeSnapshot(subscriptionId, resourceGroupId, resourceId, snapshotToPromote._blobKey)
      setActionFeedbackMessage({ ok: true, text: 'Promoted to golden baseline.' })
      loadSnapshots()
    } catch (promoteError) {
      setActionFeedbackMessage({ ok: false, text: promoteError.message })
    } finally {
      setActiveActionBlobKey(null)
    }
  }

  // Reverts the resource to the state stored in a snapshot via ARM PUT
  // Calls POST /api/genome/rollback → reads snapshot blob → calls armClient.beginCreateOrUpdateAndWait()
  // After success: sets rolledBackAt on this snapshot in genomeIndex Table
  //   and clears it on all others — so only one snapshot shows as 'Rolled Back' at a time
  const handleRollback = async (snapshotToRollback) => {
    const isResourceGroupLevel = !resourceId?.startsWith('/subscriptions/')
    const targetName = isResourceGroupLevel ? 'all resources' : (resourceName || resourceId?.split('/').pop())
    if (!window.confirm(`Rollback ${targetName} to this snapshot?`)) return

    setActiveActionBlobKey(snapshotToRollback._blobKey)
    setActionFeedbackMessage(null)
    try {
      await rollbackToSnapshot(subscriptionId, resourceGroupId, resourceId, snapshotToRollback._blobKey)
      setActionFeedbackMessage({ ok: true, text: 'Rollback applied.' })
      loadSnapshots()
      // Refresh live config so the button disables immediately after rollback
      fetchResourceConfiguration(subscriptionId, resourceGroupId, resourceId)
        .then(fresh => { if (fresh) setLiveConfig(fresh) })
        .catch(() => {})
    } catch (rollbackError) {
      setActionFeedbackMessage({ ok: false, text: rollbackError.message })
    } finally {
      setActiveActionBlobKey(null)
    }
  }

  // Permanently deletes a snapshot blob and its genomeIndex Table row
  // If the deleted snapshot was selected in the viewer, clears the viewer
  // Recover a deleted resource from a genome snapshot
  const handleRecover = async (snapshotToRecover) => {
    const targetName = snapshotToRecover.resourceState?.name || resourceId?.split('/').pop() || 'resource'
    setActiveActionBlobKey(snapshotToRecover._blobKey)
    try {
      const analysis = await analyzeRecovery(subscriptionId, resourceId, snapshotToRecover._blobKey)
      const missingMsg = analysis.missingDependencies?.length
        ? `\n\nMissing dependencies that cannot be auto-created:\n${analysis.missingDependencies.map(d => `- ${d.name} (${d.type})`).join('\n')}`
        : ''
      const warningMsg = analysis.warnings?.join('\n') || ''
      if (!window.confirm(`Recover ${targetName}?\n\n${warningMsg}${missingMsg}\n\nProceed?`)) {
        setActiveActionBlobKey(null); return
      }
      if (!analysis.canRecover) {
        setActionFeedbackMessage({ ok: false, text: `Cannot recover: missing required dependencies (${analysis.missingDependencies.map(d => d.name).join(', ')})` })
        setActiveActionBlobKey(null); return
      }
      await executeRecovery(subscriptionId, resourceGroupId, resourceId, snapshotToRecover._blobKey)
      setActionFeedbackMessage({ ok: true, text: `${targetName} recovered successfully from snapshot.` })
    } catch (error) {
      setActionFeedbackMessage({ ok: false, text: `Recovery failed: ${error.message}` })
    } finally {
      setActiveActionBlobKey(null)
    }
  }

  const handleDelete = async (snapshotToDelete) => {
    if (!window.confirm('Delete this snapshot? This cannot be undone.')) return

    setActiveActionBlobKey(snapshotToDelete._blobKey)
    setActionFeedbackMessage(null)
    try {
      await deleteGenomeSnapshot(subscriptionId, snapshotToDelete._blobKey)
      // If the deleted snapshot was open in the viewer, close it
      if (selectedSnapshot?._blobKey === snapshotToDelete._blobKey) setSelectedSnapshot(null)
      setActionFeedbackMessage({ ok: true, text: 'Snapshot deleted.' })
      loadSnapshots()  // refresh the timeline
    } catch (deleteError) {
      setActionFeedbackMessage({ ok: false, text: deleteError.message })
    } finally {
      setActiveActionBlobKey(null)
    }
  }

  // True if this is a resource-group-level snapshot (not a specific resource)
  const isResourceGroupLevel = !resourceId?.startsWith('/subscriptions/')

  // Human-readable name shown in the page subtitle
  const resourceDisplayName = resourceName || resourceId?.split('/').pop()

  if (!subscriptionId || !resourceId) {
    return (
      <div className="gp-root">
        <NavBar user={user} subscription={subscription} resourceGroup={resourceGroup} resource={resource} configData={configData} />
        <div className="gp-empty-state" role="status">
          <span className="material-symbols-outlined" style={{ fontSize: 48, color: '#c2c7d0' }}>history</span>
          <p>No resource selected. Navigate here from the Drift Scanner to view configuration snapshots.</p>
          <button className="gp-btn gp-btn--primary" onClick={() => navigate('/scanner')}>Go to Drift Scanner</button>
        </div>
      </div>
    )
  }

  return (
    <div className="gp-root">
      <NavBar user={user} subscription={subscription} resourceGroup={resourceGroup} resource={resource} configData={configData} />

      <main className="gp-main" id="main-content" role="main">
        {/* Header */}
        <header className="gp-header">
          <div>
            <h1 className="gp-headline">Configuration Genome</h1>
            <p className="gp-subline">Versioned snapshot history for <strong>{resourceDisplayName}</strong></p>
          </div>
          <div className="gp-save-row">
            {multiScopes && multiScopes.length > 1 && (
              <div style={{ minWidth: 200, zIndex: 10 }}>
                <MultiSelectDropdown
                  options={multiScopes.map((s, i) => ({
                    value: i,
                    label: s.resourceId ? s.resourceId.split("/").pop() : `${s.resourceGroupId} (all resources)`
                  }))}
                  selected={activeScopeIdx !== null ? [activeScopeIdx] : []}
                  onChange={val => {
                    if(val.length) setActiveScopeIdx(Number(val[0]))
                  }}
                  placeholder="Select a scope..."
                  singleSelect={true}
                />
              </div>
            )}
            <input className="gp-label-input" value={snapshotLabelInput} onChange={e => setSnapshotLabelInput(e.target.value)}
              placeholder="Snapshot label (optional)" aria-label="Snapshot label" />
            <button className="gp-btn gp-btn--primary" onClick={handleSave} disabled={isSavingSnapshot}>
              {isSavingSnapshot ? <><div className="gp-spinner" />Saving...</> : <>
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>Save Snapshot
              </>}
            </button>
          </div>
        </header>

        {/* RG-only warning */}

        {/* Alert */}
        {actionFeedbackMessage && (
          <div className={`gp-alert gp-alert--${actionFeedbackMessage.ok ? 'success' : 'error'}`} role="alert" aria-live="polite">{actionFeedbackMessage.text}</div>
        )}

        {/* Tab bar */}
        <div className="gp-tab-bar">
          <button
            className={`gp-tab-btn ${activeTab === 'snapshots' ? 'gp-tab-btn--active' : ''}`}
            onClick={() => setActiveTab('snapshots')}>
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>history</span>
            Snapshots
          </button>
          <button
            className={`gp-tab-btn ${activeTab === 'history' ? 'gp-tab-btn--active' : ''}`}
            onClick={() => setActiveTab('history')}>
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>manage_history</span>
            Genome History
          </button>
        </div>

        {/* Body */}
        {activeTab === 'history' ? (
          <div className="gp-history-panel">
            <GenomeHistory subscriptionId={subscriptionId} resourceId={resourceId} />
          </div>
        ) : (
          <div className="gp-body">
            {/* Timeline */}
            <div className="gp-timeline">
            {isLoadingSnapshots && <div className="gp-loading"><div className="gp-loading-ring" /><span>Loading snapshots...</span></div>}
            {!isLoadingSnapshots && snapshotList.length === 0 && (
              <div className="gp-timeline-empty">
                <span className="material-symbols-outlined" style={{ fontSize: 36, color: '#c2c7d0' }}>history</span>
                <p>No snapshots yet. Snapshots are created automatically on every change and daily.</p>
              </div>
            )}
            {/* Calendar view */}
            {(() => {
              // Group snapshots by date
              const snapshotsByDate = {}
              snapshotList.forEach(snapshot => {
                const date = snapshot.savedAt?.slice(0, 10) || ''
                if (!snapshotsByDate[date]) snapshotsByDate[date] = []
                snapshotsByDate[date].push(snapshot)
              })

              // Calendar grid for current month
              const year = calendarMonth.getFullYear()
              const month = calendarMonth.getMonth()
              const firstDay = new Date(year, month, 1).getDay()
              const daysInMonth = new Date(year, month + 1, 0).getDate()
              const monthLabel = calendarMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
              const days = []
              for (let i = 0; i < firstDay; i++) days.push(null)
              for (let d = 1; d <= daysInMonth; d++) days.push(d)

              const filteredSnapshots = selectedDate ? (snapshotsByDate[selectedDate] || []) : []

              return (
                <div>
                  {/* Month navigation */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                    <button className="gp-snap-btn gp-snap-btn--grey" onClick={() => setCalendarMonth(new Date(year, month - 1, 1))}>←</button>
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{monthLabel}</span>
                    <button className="gp-snap-btn gp-snap-btn--grey" onClick={() => setCalendarMonth(new Date(year, month + 1, 1))}>→</button>
                  </div>

                  {/* Day headers */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, textAlign: 'center', marginBottom: 4 }}>
                    {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
                      <div key={d} style={{ fontSize: 10, color: '#94a3b8', padding: 4 }}>{d}</div>
                    ))}
                  </div>

                  {/* Calendar grid */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 16 }}>
                    {days.map((day, index) => {
                      if (!day) return <div key={`empty-${index}`} />
                      const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
                      const daySnapshots = snapshotsByDate[dateStr] || []
                      const hasSnapshots = daySnapshots.length > 0
                      const hasChanges = daySnapshots.some(s => s.label?.startsWith('change-') || s.hasChanges)
                      const isSelected = selectedDate === dateStr
                      const isToday = dateStr === new Date().toISOString().slice(0, 10)
                      return (
                        <div key={dateStr}
                          onClick={() => hasSnapshots && setSelectedDate(isSelected ? null : dateStr)}
                          style={{
                            padding: '6px 2px', textAlign: 'center', borderRadius: 6, cursor: hasSnapshots ? 'pointer' : 'default',
                            background: isSelected ? 'rgba(0,96,169,0.2)' : 'transparent',
                            border: isToday ? '1px solid rgba(0,96,169,0.4)' : '1px solid transparent',
                          }}>
                          <div style={{ fontSize: 12, color: hasSnapshots ? 'var(--text-primary)' : '#cbd5e1', fontWeight: isSelected ? 700 : 400 }}>{day}</div>
                          {hasSnapshots && (
                            <div style={{ width: 6, height: 6, borderRadius: '50%', margin: '2px auto 0', background: hasChanges ? '#f59e0b' : '#10b981' }} />
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {/* Snapshots for selected date */}
                  {selectedDate && (
                    <div style={{ borderTop: '1px solid rgba(0,0,0,0.06)', paddingTop: 12 }}>
                      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
                        {new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                        {' — '}{filteredSnapshots.length} snapshot{filteredSnapshots.length !== 1 ? 's' : ''}
                      </div>
                      {filteredSnapshots.map(snapshot => (
              <div key={snapshot._blobKey} className={`gp-snap ${selectedSnapshot?._blobKey === snapshot._blobKey ? 'gp-snap--active' : ''}`}
                onClick={() => setSelectedSnapshot(snapshot)}>
                <div className="gp-snap-time">{new Date(snapshot.savedAt).toLocaleString()}</div>
                <div className="gp-snap-label">{snapshot.label || 'snapshot'}</div>
                <div className="gp-snap-actions">
                  <button className="gp-snap-btn gp-snap-btn--green"
                    onClick={e => { e.stopPropagation(); handlePromote(snapshot) }}
                    disabled={activeActionBlobKey === snapshot._blobKey || snapshot.isCurrentBaseline}
                    title={snapshot.isCurrentBaseline ? 'This snapshot is already the active baseline' : 'Promote this snapshot to golden baseline'}>
                    {activeActionBlobKey === snapshot._blobKey ? '...' : snapshot.isCurrentBaseline ? 'Current Baseline' : 'Set as Baseline'}
                  </button>
                  <button className="gp-snap-btn gp-snap-btn--red"
                    onClick={e => { e.stopPropagation(); handleRollback(snapshot) }}
                    disabled={activeActionBlobKey === snapshot._blobKey || configsMatch(snapshot.resourceState, liveConfig)}
                    title={configsMatch(snapshot.resourceState, liveConfig) ? 'Live config already matches this snapshot' : isResourceGroupLevel ? 'Rollback all resources' : 'Rollback resource'}>
                    {activeActionBlobKey === snapshot._blobKey ? '...' : configsMatch(snapshot.resourceState, liveConfig) ? 'Already Applied' : isResourceGroupLevel ? 'Rollback All' : 'Rollback'}
                  </button>
                  <button className="gp-snap-btn gp-snap-btn--grey"
                    onClick={e => { e.stopPropagation(); handleDelete(snapshot) }}
                    disabled={activeActionBlobKey === snapshot._blobKey}>
                    {activeActionBlobKey === snapshot._blobKey ? '...' : 'Delete'}
                  </button>
                </div>
              </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })()}
          </div>

          {/* JSON viewer */}
          <div className="gp-viewer">
            {selectedSnapshot ? (
              <div className="gp-viewer-card">
                <div className="gp-viewer-header">
                  <h3>Snapshot — {new Date(selectedSnapshot.savedAt).toLocaleString()}</h3>
                  {selectedSnapshot.label && <span className="gp-viewer-label">{selectedSnapshot.label}</span>}
                </div>
                <div className="gp-viewer-body">
                  <JsonTree data={selectedSnapshot.resourceState} />
                </div>
              </div>
            ) : (
              <div className="gp-viewer-empty">
                <span className="material-symbols-outlined" style={{ fontSize: 40, color: '#c2c7d0' }}>arrow_back</span>
                <p>Select a snapshot to view its configuration</p>
              </div>
            )}
          </div>
        </div>
        )}
      </main>
    </div>
  )
}
