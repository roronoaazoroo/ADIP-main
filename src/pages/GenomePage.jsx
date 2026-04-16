import React, { useState, useEffect, useCallback } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import JsonTree from '../components/JsonTree'
import NavBar from '../components/NavBar'
import { useDashboard } from '../context/DashboardContext'
import { fetchGenomeSnapshots, saveGenomeSnapshot, promoteGenomeSnapshot, rollbackToSnapshot, deleteGenomeSnapshot } from '../services/api'
import './GenomePage.css'

export default function GenomePage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { subscriptionId, resourceGroupId, resourceId, resourceName } = location.state ?? {}
  const { subscription, resourceGroup, resource, configData } = useDashboard()
  const user = (() => { try { return JSON.parse(sessionStorage.getItem('user') || '{}') } catch { return {} } })()

  const [snapshots, setSnapshots] = useState([])
  const [loading,   setLoading]   = useState(false)
  const [selected,  setSelected]  = useState(null)
  const [label,     setLabel]     = useState('')
  const [saving,    setSaving]    = useState(false)
  const [actionMsg, setActionMsg] = useState(null)
  const [acting,    setActing]    = useState(null)

  const load = useCallback(async () => {
    if (!subscriptionId) return
    setLoading(true)
    try { setSnapshots((await fetchGenomeSnapshots(subscriptionId, resourceId)) || []) }
    catch (e) { setActionMsg({ ok: false, text: e.message }) }
    finally { setLoading(false) }
  }, [subscriptionId, resourceId])

  useEffect(() => { load() }, [load])

  const handleSave = async () => {
    setSaving(true); setActionMsg(null)
    try {
      await saveGenomeSnapshot(subscriptionId, resourceGroupId, resourceId, label || 'manual snapshot')
      setLabel(''); setActionMsg({ ok: true, text: 'Snapshot saved.' }); load()
    } catch (e) { setActionMsg({ ok: false, text: e.message }) }
    finally { setSaving(false) }
  }

  const handlePromote = async (snap) => {
    setActing(snap._blobKey); setActionMsg(null)
    try {
      await promoteGenomeSnapshot(subscriptionId, resourceGroupId, resourceId, snap._blobKey)
      setActionMsg({ ok: true, text: `Promoted to golden baseline.` })
    } catch (e) { setActionMsg({ ok: false, text: e.message }) }
    finally { setActing(null) }
  }

  const handleRollback = async (snap) => {
    const isRgLevel = !resourceId?.startsWith('/subscriptions/')
    if (!window.confirm(`Rollback ${isRgLevel ? 'all resources' : resourceName || resourceId?.split('/').pop()} to this snapshot?`)) return
    setActing(snap._blobKey); setActionMsg(null)
    try {
      await rollbackToSnapshot(subscriptionId, resourceGroupId, resourceId, snap._blobKey)
      setActionMsg({ ok: true, text: 'Rollback applied.' })
    } catch (e) { setActionMsg({ ok: false, text: e.message }) }
    finally { setActing(null) }
  }

  const handleDelete = async (snap) => {
    if (!window.confirm('Delete this snapshot? This cannot be undone.')) return
    setActing(snap._blobKey); setActionMsg(null)
    try {
      await deleteGenomeSnapshot(subscriptionId, snap._blobKey)
      if (selected?._blobKey === snap._blobKey) setSelected(null)
      setActionMsg({ ok: true, text: 'Snapshot deleted.' }); load()
    } catch (e) { setActionMsg({ ok: false, text: e.message }) }
    finally { setActing(null) }
  }

  const isRgLevel   = !resourceId?.startsWith('/subscriptions/')
  const displayName = resourceName || resourceId?.split('/').pop()

  if (!subscriptionId || !resourceId) {
    return (
      <div className="gp-root">
        <NavBar user={user} subscription={subscription} resourceGroup={resourceGroup} resource={resource} configData={configData} />
        <div className="gp-empty-state">
          <span className="material-symbols-outlined" style={{ fontSize: 48, color: '#c2c7d0' }}>history</span>
          <p>No resource selected. Navigate here from the Drift Scanner.</p>
          <button className="gp-btn gp-btn--primary" onClick={() => navigate('/dashboard')}>Go to Drift Scanner</button>
        </div>
      </div>
    )
  }

  return (
    <div className="gp-root">
      <NavBar user={user} subscription={subscription} resourceGroup={resourceGroup} resource={resource} configData={configData} />

      <main className="gp-main">
        {/* Header */}
        <header className="gp-header">
          <div>
            <h1 className="gp-headline">Configuration Genome</h1>
            <p className="gp-subline">Versioned snapshot history for <strong>{displayName}</strong></p>
          </div>
          <div className="gp-save-row">
            <input className="gp-label-input" value={label} onChange={e => setLabel(e.target.value)}
              placeholder="Snapshot label (optional)" />
            <button className="gp-btn gp-btn--primary" onClick={handleSave} disabled={saving}>
              {saving ? <><div className="gp-spinner" />Saving...</> : <>
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>Save Snapshot
              </>}
            </button>
          </div>
        </header>

        {/* Alert */}
        {actionMsg && (
          <div className={`gp-alert gp-alert--${actionMsg.ok ? 'success' : 'error'}`}>{actionMsg.text}</div>
        )}

        {/* Body */}
        <div className="gp-body">
          {/* Timeline */}
          <div className="gp-timeline">
            {loading && <div className="gp-loading"><div className="gp-loading-ring" /><span>Loading snapshots...</span></div>}
            {!loading && snapshots.length === 0 && (
              <div className="gp-timeline-empty">
                <span className="material-symbols-outlined" style={{ fontSize: 36, color: '#c2c7d0' }}>history</span>
                <p>No snapshots yet. Save one above.</p>
              </div>
            )}
            {snapshots.map(snap => (
              <div key={snap._blobKey} className={`gp-snap ${selected?._blobKey === snap._blobKey ? 'gp-snap--active' : ''}`}
                onClick={() => setSelected(snap)}>
                <div className="gp-snap-time">{new Date(snap.savedAt).toLocaleString()}</div>
                <div className="gp-snap-label">{snap.label || 'snapshot'}</div>
                <div className="gp-snap-actions">
                  <button className="gp-snap-btn gp-snap-btn--green"
                    onClick={e => { e.stopPropagation(); handlePromote(snap) }}
                    disabled={acting === snap._blobKey}>
                    {acting === snap._blobKey ? '...' : 'Set as Baseline'}
                  </button>
                  <button className="gp-snap-btn gp-snap-btn--red"
                    onClick={e => { e.stopPropagation(); handleRollback(snap) }}
                    disabled={acting === snap._blobKey}
                    title={isRgLevel ? 'Rollback all resources' : 'Rollback resource'}>
                    {acting === snap._blobKey ? '...' : isRgLevel ? 'Rollback All' : 'Rollback'}
                  </button>
                  <button className="gp-snap-btn gp-snap-btn--grey"
                    onClick={e => { e.stopPropagation(); handleDelete(snap) }}
                    disabled={acting === snap._blobKey}>
                    {acting === snap._blobKey ? '...' : 'Delete'}
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* JSON viewer */}
          <div className="gp-viewer">
            {selected ? (
              <div className="gp-viewer-card">
                <div className="gp-viewer-header">
                  <h3>Snapshot — {new Date(selected.savedAt).toLocaleString()}</h3>
                  {selected.label && <span className="gp-viewer-label">{selected.label}</span>}
                </div>
                <div className="gp-viewer-body">
                  <JsonTree data={selected.resourceState} />
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
      </main>
    </div>
  )
}
