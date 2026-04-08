import React, { useRef, useEffect, useState, useMemo } from 'react'

function resolveUser(ev) {
  if (ev.caller && ev.caller !== 'unknown' && ev.caller !== 'Unknown user' && ev.caller !== 'System') return ev.caller
  if (ev.caller === 'System' || !ev.caller) {
    const svc = (ev.operationName || '').split('/')[0]?.replace('Microsoft.', '') || 'System'
    return `System (${svc})`
  }
  try { const u = JSON.parse(sessionStorage.getItem('user') || '{}'); return u.name || u.username || 'Unknown user' }
  catch { return 'Unknown user' }
}

function getEventIcon(icon) {
  const icons = {
    scan:    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>,
    connect: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1"/></svg>,
    fetch:   <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
    compare: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#06b6d4" strokeWidth="2"><path d="M16 3h5v5M8 3H3v5M3 16v5h5M21 16v5h-5"/></svg>,
    done:    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>,
  }
  return icons[icon] || icons.fetch
}

export default function LiveActivityFeed({ liveEvents, driftEvents, isScanning, isMonitoring, socketConnected, onClear }) {
  const logRef = useRef(null)
  const [userFilter, setUserFilter] = useState('')

  const uniqueUsers = useMemo(() => [...new Set(driftEvents.map(resolveUser))].sort(), [driftEvents])
  const filtered    = useMemo(() => userFilter ? driftEvents.filter(ev => resolveUser(ev) === userFilter) : driftEvents, [driftEvents, userFilter])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [liveEvents, driftEvents])

  const downloadCSV = () => {
    const rows = [['Time','User','Action','Resource','ResourceType','ResourceGroup','Operation','FieldsChanged','Changes']]
    liveEvents.forEach(ev => rows.push([ev.timestamp||'','',ev.type||'','','','',ev.message||'','','']))
    driftEvents.forEach(ev => {
      const user = resolveUser(ev)
      const time = ev.eventTime ? new Date(ev.eventTime).toLocaleString() : ev._receivedAt || ''
      const isDelete = ev.eventType?.includes('Delete')
      const isCreate = ev.operationName?.toLowerCase().includes('write') && !ev.hasPrevious
      const action = isDelete ? 'deleted' : isCreate ? 'created' : 'modified'
      const changes = (ev.changes||[]).map(c => {
        const p = (c.path||'').split(' → ').filter(s=>s&&s!=='_childConfig').slice(-3).join('.')
        const ov = c.oldValue != null ? String(typeof c.oldValue==='object'?JSON.stringify(c.oldValue):c.oldValue) : ''
        const nv = c.newValue != null ? String(typeof c.newValue==='object'?JSON.stringify(c.newValue):c.newValue) : ''
        return ov&&nv ? `${p}: ${ov} -> ${nv}` : ov ? `${p}: removed (was ${ov})` : `${p}: added (${nv})`
      }).join(' | ')
      rows.push([time,user,action,ev.resourceId?.split('/').pop()||'',ev.resourceId?.split('/')?.[7]||'',ev.resourceGroup||'',ev.operationName||'',ev.changes?.length||0,changes])
    })
    const csv = rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'}))
    a.download = `adip-activity-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.csv`
    a.click(); URL.revokeObjectURL(a.href)
  }

  return (
    <section className="panel panel-live">
      <div className="panel-header">
        <div className="panel-header-left">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--ct-coral-blue)" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          <h3>Live Activity</h3>
          {isScanning && <div className="live-indicator" />}
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          {isMonitoring && <span className="socket-connected-badge" title="Polling every 30s"><span className="socket-dot"/>Monitoring</span>}
          {socketConnected && !isMonitoring && <span className="socket-connected-badge"><span className="socket-dot"/>Live</span>}
          <span className="panel-badge">{liveEvents.length + driftEvents.length} events</span>
          {uniqueUsers.length > 0 && (
            <select value={userFilter} onChange={e=>setUserFilter(e.target.value)}
              style={{fontSize:11,padding:'2px 6px',borderRadius:4,border:'1px solid rgba(255,255,255,0.12)',background:'rgba(255,255,255,0.06)',color:'#e2e8f0',cursor:'pointer'}}>
              <option value=''>All users</option>
              {uniqueUsers.map(u=><option key={u} value={u}>{u}</option>)}
            </select>
          )}
          {(liveEvents.length > 0 || driftEvents.length > 0) && (
            <button onClick={downloadCSV} title="Download as CSV"
              style={{background:'none',border:'1px solid rgba(255,255,255,0.12)',borderRadius:4,padding:'2px 8px',color:'#94a3b8',cursor:'pointer',fontSize:11,display:'flex',alignItems:'center',gap:4}}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              CSV
            </button>
          )}
        </div>
      </div>

      <div className="panel-body panel-body-log" ref={logRef}>
        {liveEvents.length === 0 && driftEvents.length === 0 && (
          <div className="panel-empty">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--ct-grey-300)" strokeWidth="1.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            <p>Activity log will appear here during operations</p>
          </div>
        )}

        {liveEvents.map(ev => (
          <div key={ev.id} className={`log-entry log-entry-${ev.type}`}>
            <span className="log-time">{ev.timestamp}</span>
            <span className="log-icon">{getEventIcon(ev.icon)}</span>
            <span className="log-message">{ev.message}</span>
          </div>
        ))}

        {filtered.length > 0 && <div className="drift-feed-divider"><span>Live resource changes</span></div>}

        {filtered.map(ev => {
          const user        = resolveUser(ev)
          const resName     = ev.resourceId?.split('/').pop() ?? ev.subject ?? 'resource'
          const resType     = ev.resourceId?.split('/')?.[7] ?? ''
          const isDelete    = ev.eventType?.includes('Delete')
          const isCreate    = ev.operationName?.toLowerCase().includes('write') && !ev.hasPrevious
          const action      = isDelete ? 'deleted' : isCreate ? 'created' : 'modified'
          const actionColor = isDelete ? '#ef4444' : isCreate ? '#22c55e' : '#f59e0b'
          const azureTime   = ev.eventTime ? new Date(ev.eventTime).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}) : ev._receivedAt
          const op          = ev.operationName?.split('/')?.slice(-1)[0] ?? ''

          return (
            <div key={ev._clientId} style={{padding:'8px 10px',borderBottom:'1px solid rgba(255,255,255,0.05)',display:'flex',flexDirection:'column',gap:4}}>
              <div style={{display:'flex',alignItems:'center',gap:6,flexWrap:'wrap'}}>
                <span style={{fontSize:10,color:'#64748b',fontFamily:'monospace',minWidth:60}}>{azureTime}</span>
                <span style={{fontSize:11,fontWeight:700,color:'#818cf8',background:'rgba(129,140,248,0.1)',padding:'1px 6px',borderRadius:3}}>{user}</span>
                <span style={{fontSize:11,fontWeight:600,color:actionColor}}>{action}</span>
                <span style={{fontSize:11,fontFamily:'monospace',color:'#93c5fd',fontWeight:600}}>{resName}</span>
                {resType && <span style={{fontSize:10,color:'#475569',background:'rgba(255,255,255,0.04)',padding:'1px 5px',borderRadius:3}}>{resType}</span>}
                {op && op!=='write' && op!=='delete' && <span style={{fontSize:10,color:'#64748b'}}>via {op}</span>}
                {ev.resourceGroup && <span style={{fontSize:10,color:'#475569'}}>in {ev.resourceGroup}</span>}
                {ev.changes?.length > 0 && <span style={{fontSize:10,color:'#94a3b8',marginLeft:'auto'}}>{ev.changes.length} field{ev.changes.length>1?'s':''} changed</span>}
              </div>
              {ev.changes?.length > 0 && (
                <div style={{paddingLeft:8,borderLeft:'2px solid rgba(255,255,255,0.06)',marginLeft:4,display:'flex',flexDirection:'column',gap:2}}>
                  {ev.changes.slice(0,8).map((c,i) => {
                    const tc = {modified:'#f59e0b',added:'#22c55e',removed:'#ef4444','array-added':'#22c55e','array-removed':'#ef4444'}[c.type]||'#94a3b8'
                    const segs = (c.path||'').split(' → ').filter(s=>s&&s!=='_childConfig')
                    const dp   = segs.slice(-3).join(' → ')
                    const dOld = c.oldValue!=null ? String(typeof c.oldValue==='object'?JSON.stringify(c.oldValue):c.oldValue).slice(0,50) : null
                    const dNew = c.newValue!=null ? String(typeof c.newValue==='object'?JSON.stringify(c.newValue):c.newValue).slice(0,50) : null
                    return (
                      <div key={i} style={{fontSize:11,display:'flex',alignItems:'baseline',gap:5,flexWrap:'wrap'}}>
                        <span style={{fontSize:9,fontWeight:700,color:tc,textTransform:'uppercase',minWidth:44}}>{c.type?.replace('-',' ')}</span>
                        <span style={{fontFamily:'monospace',color:'#93c5fd'}}>{dp}</span>
                        {dOld!=null&&dNew!=null && <span style={{fontSize:10}}><span style={{color:'#ef4444',textDecoration:'line-through'}}>{dOld}</span><span style={{margin:'0 4px',color:'#475569'}}>→</span><span style={{color:'#22c55e'}}>{dNew}</span></span>}
                        {dOld!=null&&dNew==null && <span style={{fontSize:10,color:'#ef4444'}}>was: {dOld}</span>}
                        {dOld==null&&dNew!=null && <span style={{fontSize:10,color:'#22c55e'}}>now: {dNew}</span>}
                      </div>
                    )
                  })}
                  {ev.changes.length > 8 && <div style={{fontSize:10,color:'#475569'}}>+{ev.changes.length-8} more fields</div>}
                </div>
              )}
              {(!ev.changes||ev.changes.length===0) && ev.operationName && (
                <div style={{paddingLeft:12,fontSize:10,color:'#475569'}}>
                  operation: <span style={{color:'#64748b',fontFamily:'monospace'}}>{ev.operationName}</span>
                  {!ev.hasPrevious && <span style={{color:'#475569',marginLeft:6}}>(submit again to enable field-level diff)</span>}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
