// ============================================================
// FILE: src/components/OrgMembersPanel.jsx
// ROLE: Shows org members list with role management (admin only)
// ============================================================
import React, { useState, useEffect } from 'react'
import { fetchOrgMembers, updateMemberRole, getCurrentUser } from '../services/authService'
import { getSocket } from '../services/socketSingleton'
import './OrgMembersPanel.css'

const ROLE_COLOR = {
  admin:     '#1995ff',
  approver:  '#10b981',
  requestor: '#f59e0b',
}

export default function OrgMembersPanel() {
  const [members, setMembers]           = useState([])
  const [organization, setOrganization] = useState(null)
  const [loading, setLoading]           = useState(true)
  const [error, setError]               = useState(null)

  const currentUser = getCurrentUser()
  const isAdmin     = currentUser?.role === 'admin'

  const loadMembers = () => {
    fetchOrgMembers()
      .then(data => {
        setMembers(data.members || data)
        setOrganization(data.organization || null)
      })
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

  if (loading) return (
    <div className="omp-loading">
      <span className="omp-loading-spinner" />
      Loading members…
    </div>
  )

  if (error) return (
    <div className="omp-error">{error}</div>
  )

  return (
    <div className="omp-root">
      {/* Header */}
      <div className="omp-header">
        <span className="material-symbols-outlined omp-header-icon">group</span>
        <h3 className="omp-org-name">
          {organization?.organizationName || 'Organization Members'}
        </h3>
        {organization?.inviteCode && (
          <span className="omp-invite-code" title="Invite code — share with team members">
            {organization.inviteCode}
          </span>
        )}
      </div>

      <div className="omp-count">
        {members.length} member{members.length !== 1 ? 's' : ''}
      </div>

      {/* Member list */}
      <div className="omp-list">
        {members.map((member, idx) => {
          const roleColor = ROLE_COLOR[member.role] || '#64748b'
          const initial   = (member.name || member.email)[0].toUpperCase()

          return (
            <div
              key={member.userId}
              className="omp-member"
              style={{ animationDelay: `${idx * 0.05}s` }}
            >
              {/* Avatar */}
              <div
                className="omp-avatar"
                style={{ background: `${roleColor}22`, color: roleColor }}
              >
                {initial}
              </div>

              {/* Info */}
              <div className="omp-info">
                <div className="omp-name">{member.name || member.email.split('@')[0]}</div>
                <div className="omp-email">{member.email}</div>
              </div>

              {/* Role — editable for admin, badge for others */}
              {isAdmin && member.role !== 'admin' ? (
                <select
                  className="omp-role-select"
                  value={member.role}
                  onChange={e => handleRoleChange(member.userId, e.target.value)}
                  style={{ color: roleColor }}
                >
                  <option value="approver">Approver</option>
                  <option value="requestor">Requestor</option>
                </select>
              ) : (
                <span
                  className="omp-role-badge"
                  style={{
                    background: `${roleColor}18`,
                    color: roleColor,
                  }}
                >
                  {member.role}
                </span>
              )}

              {/* Joined date */}
              <div className="omp-joined">
                {member.joinedAt
                  ? new Date(member.joinedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                  : ''}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
