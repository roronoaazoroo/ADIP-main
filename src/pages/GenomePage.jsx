import React, { useState, useEffect, useCallback } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import Sidebar from '../components/Sidebar'
import JsonTree from '../components/JsonTree'
import { fetchGenomeSnapshots, saveGenomeSnapshot, promoteGenomeSnapshot, rollbackToSnapshot } from '../services/api'

export default function GenomePage() {
  const navigate  = useNavigate()
  const location  = useLocation()
  const { subscriptionId, resourceGroupId, resourceId, resourceName } = location.state ?? {}

  const [snapshots,   setSnapshots]   = useState([])
  const [loading,     setLoading]     = useState(false)
  const [selected,    setSelected]    = useState(null)
  const [label,       setLabel]       = useState('')
  const [saving,      setSaving]      = useState(false)
  const [actionMsg,   setActionMsg]   = useState(null)
  const [acting,      setActing]      = useState(null) // blobKey of in-progress action

  const load = useCallback(async () => {
    if (!subscriptionId) return
    setLoading(true)
    try {
      const data = await fetchGenomeSnapshots(subscriptionId, resourceId)
      setSnapshots(data || [])
    } catch (e) {
      setActionMsg({ ok: false, text: e.message })
    } finally {
      setLoading(false)
    }
  }, [subscriptionId, resourceId])

  useEffect(() => { load() }, [load])

  const handleSave = async () => {
    setSaving(true)
    setActionMsg(null)
    try {
      await saveGenomeSnapshot(subscriptionId, resourceGroupId, resourceId, label || `manual snapshot`)
      setLabel('')
      setActionMsg({ ok: true, text: 'Snapshot saved to genome.' })
      load()
    } catch (e) {
      setActionMsg({ ok: false, text: e.message })
    } finally {
      setSaving(false)
    }
  }

  const handlePromote = async (snap) => {
    setActing(snap._blobKey)
    setActionMsg(null)
    try {
      await promoteGenomeSnapshot(subscriptionId, resourceGroupId, resourceId, snap._blobKey)
      setActionMsg({ ok: true, text: `Snapshot from ${new Date(snap.savedAt).toLocaleString()} promoted to golden baseline.` })
    } catch (e) {
      setActionMsg({ ok: false, text: e.message })
    } finally {
      setActing(null)
    }
  }

  const handleRollback = async (snap) => {
    if (!window.confirm(`Rollback ${resourceName || resourceId?.split('/').pop()} to snapshot from ${new Date(snap.savedAt).toLocaleString()}?\n\nThis will apply the snapshot config via ARM PUT.`)) return
    setActing(snap._blobKey)
    setActionMsg(null)
    try {
      await rollbackToSnapshot(subscriptionId, resourceGroupId, resourceId, snap._blobKey)
      setActionMsg({ ok: true, text: `Rollback applied. Resource reverted to snapshot from ${new Date(snap.savedAt).toLocaleString()}.` })
    } catch (e) {
      setActionMsg({ ok: false, text: e.message })
    } finally {
      setActing(null)
    }
  }

  if (!subscriptionId || !resourceId) {
    return (
      <div className="dashboard">
        <Sidebar />
        <div className="dashboard-main-wrapper" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8' }}>
          <div style={{ textAlign: 'center' }}>
            <p>No resource selected. Navigate here from the Dashboard.</p>
            <button className="btn btn-primary" style={{ width: 'auto', marginTop: 12 }} onClick={() => navigate('/dashboard')}>← Go to Dashboard</button>
          </div>
        </div>
      </div>
    )
  }

  const displayName = resourceName || resourceId?.split('/').pop()

  return (
    <div className="dashboard">
      <Sidebar />
      <div className="dashboard-main-wrapper">
        <nav className="dashboard-nav">
          <div className="dashboard-nav-left">
            <button className="back-btn" onClick={() => navigate('/dashboard')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
              Back
            </button>
            <div className="dashboard-nav-title">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--ct-coral-blue)" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
              <span>Configuration Genome</span>
            </div>
            <span style={{ fontSize: 12, color: '#64748b' }}>{displayName}</span>
          </div>
          {/* Save snapshot controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="Snapshot label (optional)"
              style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(15, 64, 198, 0.12)', background: 'rgba(255,255,255,0.06)', color: '#020a14', width: 220 }}
            />
            <button className="btn btn-primary" style={{ width: 'auto', padding: '6px 14px', fontSize: 12 }} onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : '+ Save Snapshot'}
            </button>
          </div>
        </nav>

        <div style={{ padding: '16px 24px', display: 'flex', gap: 16, height: 'calc(100vh - 56px)', overflow: 'hidden' }}>
          {/* Left: snapshot timeline */}
          <div style={{ width: 340, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto' }}>
            {actionMsg && (
              <div style={{ padding: '10px 14px', borderRadius: 6, background: actionMsg.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', border: `1px solid ${actionMsg.ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`, fontSize: 12, color: actionMsg.ok ? '#22c55e' : '#ef4444' }}>
                {actionMsg.text}
              </div>
            )}
            {loading && <div style={{ color: '#64748b', fontSize: 12, padding: 8 }}>Loading snapshots...</div>}
            {!loading && snapshots.length === 0 && (
              <div style={{ color: '#475569', fontSize: 12, padding: 16, textAlign: 'center' }}>
                No snapshots yet.<br/>Save one above or trigger a resource change.
              </div>
            )}
            {snapshots.map(snap => (
              <div
                key={snap._blobKey}
                onClick={() => setSelected(snap)}
                style={{
                  padding: '10px 14px', borderRadius: 8, cursor: 'pointer',
                  border: `1px solid ${selected?._blobKey === snap._blobKey ? 'rgba(99,102,241,0.5)' : 'rgba(255,255,255,0.06)'}`,
                  background: selected?._blobKey === snap._blobKey ? 'rgba(99,102,241,0.08)' : 'rgba(255,255,255,0.02)',
                }}
              >
                <div style={{ fontSize: 11, color: '#818cf8', marginBottom: 3 }}>{new Date(snap.savedAt).toLocaleString()}</div>
                <div style={{ fontSize: 12, color: '#e2e8f0', marginBottom: 6 }}>{snap.label || 'snapshot'}</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={e => { e.stopPropagation(); handlePromote(snap) }}
                    disabled={acting === snap._blobKey}
                    style={{ fontSize: 10, padding: '3px 8px', borderRadius: 4, border: '1px solid rgba(34,197,94,0.3)', background: 'rgba(34,197,94,0.08)', color: '#22c55e', cursor: 'pointer' }}
                  >
                    {acting === snap._blobKey ? '...' : '★ Set as Baseline'}
                  </button>
                  <button
                    onClick={e => { e.stopPropagation(); handleRollback(snap) }}
                    disabled={acting === snap._blobKey}
                    style={{ fontSize: 10, padding: '3px 8px', borderRadius: 4, border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.08)', color: '#ef4444', cursor: 'pointer' }}
                  >
                    {acting === snap._blobKey ? '...' : '↩ Rollback'}
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Right: snapshot JSON viewer */}
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {selected ? (
              <div className="panel" style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                <div className="panel-header">
                  <div className="panel-header-left">
                    <h3>Snapshot — {new Date(selected.savedAt).toLocaleString()}</h3>
                  </div>
                  <span style={{ fontSize: 11, color: '#64748b' }}>{selected.label}</span>
                </div>
                <div className="panel-body panel-body-json" style={{ flex: 1, overflow: 'auto' }}>
                  <JsonTree data={selected.resourceState} />
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#475569', fontSize: 13 }}>
                Select a snapshot to view its configuration
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
