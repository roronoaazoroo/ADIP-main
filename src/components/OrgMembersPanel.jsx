// ============================================================
// FILE: src/components/OrgMembersPanel.jsx
// ROLE: Shows org members list with role management (admin only)
// ============================================================
import React, { useState, useEffect } from 'react'
import { fetchOrgMembers, updateMemberRole, getCurrentUser } from '../services/authService'
import { getSocket } from '../services/socketSingleton'

export default function OrgMembersPanel() {
  const [members, setMembers] = useState([])
  const [organization, setOrganization] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const currentUser = getCurrentUser()
  const isAdmin = currentUser?.role === 'admin'

  const loadMembers = () => {
    fetchOrgMembers()
      .then(data => { setMembers(data.members || data); setOrganization(data.organization || null) })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { loadMembers() }, [])

  // Auto-refresh on role change via Socket.IO
  useEffect(() => {
    const socket = getSocket()
    if (!socket) return
    const handleRoleChange = () => loadMembers()
    socket.on('roleChange', handleRoleChange)
    return () => socket.off('roleChange', handleRoleChange)
  }, [])

  const handleRoleChange = async (userId, newRole) => {
    try {
      await updateMemberRole(userId, newRole)
      setMembers(prev => prev.map(m => m.userId === userId ? { ...m, role: newRole } : m))
    } catch (err) { setError(err.message) }
  }

  const roleColor = { admin: '#0060a9', approver: '#10b981', requestor: '#f59e0b' }

  if (loading) return <div style={{ padding: 16, color: 'rgba(255,255,255,0.5)', fontSize: 13 }}>Loading members...</div>
  if (error) return <div style={{ padding: 16, color: '#ef4444', fontSize: 13 }}>{error}</div>

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span className="material-symbols-outlined" style={{ color: '#0060a9', fontSize: 20 }}>group</span>
        <h3 style={{ margin: 0, fontSize: 16, color: 'var(--text-primary)' }}>{organization?.organizationName || 'Organization Members'}</h3>
        {organization?.inviteCode && (
          <span style={{ marginLeft: 'auto', fontSize: 12, fontFamily: 'monospace', fontWeight: 700, padding: '3px 10px', borderRadius: 4, background: 'rgba(0,96,169,0.1)', color: '#60a5fa', border: '1px solid rgba(0,96,169,0.2)' }}>{organization.inviteCode}</span>
        )}
      </div>
      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginBottom: 16 }}>{members.length} member{members.length !== 1 ? 's' : ''}</div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {members.map(member => (
          <div key={member.userId} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: 'rgba(255,255,255,0.02)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ width: 32, height: 32, borderRadius: '50%', background: `${roleColor[member.role]}20`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontSize: 14, color: roleColor[member.role], fontWeight: 700 }}>{(member.name || member.email)[0].toUpperCase()}</span>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{member.name || member.email.split('@')[0]}</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>{member.email}</div>
            </div>
            {isAdmin && member.role !== 'admin' ? (
              <select value={member.role} onChange={e => handleRoleChange(member.userId, e.target.value)}
                style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.04)', color: roleColor[member.role], fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                <option value="approver">Approver</option>
                <option value="requestor">Requestor</option>
              </select>
            ) : (
              <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 4, background: `${roleColor[member.role]}15`, color: roleColor[member.role], textTransform: 'capitalize' }}>
                {member.role}
              </span>
            )}
            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', minWidth: 70, textAlign: 'right' }}>
              {member.joinedAt ? new Date(member.joinedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
