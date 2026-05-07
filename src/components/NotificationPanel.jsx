// ============================================================
// FILE: src/components/NotificationPanel.jsx
// ROLE: Slide-out panel from NavBar bell — Notifications + Pending Approvals
// ============================================================
import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchNotifications, markNotificationRead, getCurrentUser } from '../services/authService'
import { fetchTickets, approveTicket, rejectTicket } from '../services/api'
import { getSocket } from '../services/socketSingleton'

export default function NotificationPanel({ isOpen, onClose }) {
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState('approvals')
  const [notifications, setNotifications] = useState([])
  const [tickets, setTickets] = useState([])
  const [expandedTicket, setExpandedTicket] = useState(null)
  const [rejectReason, setRejectReason] = useState('')
  const [actionLoading, setActionLoading] = useState(null)
  const currentUser = getCurrentUser()
  const sessionUser = (() => { try { return JSON.parse(sessionStorage.getItem('user') || '{}') } catch { return {} } })()
  const effectiveRole = sessionUser?.role || currentUser?.role
  const isApprover = effectiveRole === 'admin' || effectiveRole === 'approver'

  useEffect(() => {
    if (!isOpen) return
    fetchNotifications().then(setNotifications).catch(() => {})
    fetchTickets().then(setTickets).catch(() => {})
  }, [isOpen])

  // Real-time updates via Socket.IO
  useEffect(() => {
    const socket = getSocket()
    if (!socket) return
    const handleNewNotification = () => { fetchNotifications().then(setNotifications).catch(() => {}) }
    const handleTicketUpdate = () => { fetchTickets().then(setTickets).catch(() => {}) }
    socket.on('newNotification', handleNewNotification)
    socket.on('ticketUpdate', handleTicketUpdate)
    socket.on('roleChange', handleNewNotification)
    return () => {
      socket.off('newNotification', handleNewNotification)
      socket.off('ticketUpdate', handleTicketUpdate)
      socket.off('roleChange', handleNewNotification)
    }
  }, [])

  const handleMarkRead = async (rowKey) => {
    await markNotificationRead(rowKey).catch(() => {})
    setNotifications(prev => prev.map(n => n.rowKey === rowKey ? { ...n, read: true } : n))
  }

  const handleApprove = async (ticketId) => {
    setActionLoading(ticketId)
    try {
      const result = await approveTicket(ticketId)
      setTickets(prev => prev.map(t => t.ticketId === ticketId ? { ...t, currentApprovals: result.currentApprovals, status: result.status } : t))
    } catch {}
    setActionLoading(null)
  }

  const handleReject = async (ticketId) => {
    setActionLoading(ticketId)
    try {
      await rejectTicket(ticketId, rejectReason)
      setTickets(prev => prev.map(t => t.ticketId === ticketId ? { ...t, status: 'rejected' } : t))
      setRejectReason('')
    } catch {}
    setActionLoading(null)
  }

  const handleDetailedView = (ticket) => {
    onClose()
    navigate('/comparison', {
      state: { subscriptionId: ticket.subscriptionId, resourceGroupId: ticket.resourceGroupId, resourceId: ticket.resourceId, resourceName: ticket.resourceName }
    })
  }

  const unreadCount = notifications.filter(n => !n.read).length
  const pendingTickets = tickets.filter(t => t.status === 'pending')
  const myTickets = tickets.filter(t => t.createdBy === currentUser?.userId)

  if (!isOpen) return null

  const panelStyle = { position: 'fixed', top: 0, right: 0, width: 420, height: '100vh', background: 'var(--panel-bg, #141820)', borderLeft: '1px solid rgba(255,255,255,0.08)', zIndex: 1000, display: 'flex', flexDirection: 'column', boxShadow: '-4px 0 24px rgba(0,0,0,0.4)' }
  const overlayStyle = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 999 }
  const tabStyle = (active) => ({ padding: '8px 16px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: active ? 'rgba(0,96,169,0.15)' : 'transparent', color: active ? '#60a5fa' : 'rgba(255,255,255,0.5)', borderBottom: active ? '2px solid #0060a9' : '2px solid transparent' })
  const cardStyle = { padding: '12px 14px', background: 'rgba(255,255,255,0.02)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)', marginBottom: 8 }
  const severityColor = { critical: '#ef4444', high: '#f97316', medium: '#f59e0b', low: '#facc15' }

  return (
    <>
      <div style={overlayStyle} onClick={onClose} />
      <div style={panelStyle}>
        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>Notifications</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontSize: 18 }}>✕</button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <button style={tabStyle(activeTab === 'approvals')} onClick={() => setActiveTab('approvals')}>
            Approvals {pendingTickets.length > 0 && <span style={{ marginLeft: 4, background: '#ef4444', color: '#fff', borderRadius: 8, padding: '1px 6px', fontSize: 10 }}>{pendingTickets.length}</span>}
          </button>
          <button style={tabStyle(activeTab === 'notifications')} onClick={() => setActiveTab('notifications')}>
            Activity {unreadCount > 0 && <span style={{ marginLeft: 4, background: '#0060a9', color: '#fff', borderRadius: 8, padding: '1px 6px', fontSize: 10 }}>{unreadCount}</span>}
          </button>
          <button style={tabStyle(activeTab === 'myRequests')} onClick={() => setActiveTab('myRequests')}>My Requests</button>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>

          {/* Pending Approvals */}
          {activeTab === 'approvals' && (
            pendingTickets.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 32, color: 'rgba(255,255,255,0.3)', fontSize: 13 }}>No pending approvals</div>
            ) : pendingTickets.map(ticket => (
              <div key={ticket.ticketId} style={cardStyle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)' }}>{ticket.resourceName}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 3, background: `${severityColor[ticket.severity] || '#64748b'}18`, color: severityColor[ticket.severity] || '#64748b', textTransform: 'uppercase' }}>{ticket.severity}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: '#10b981', fontWeight: 600 }}>{ticket.currentApprovals}/{ticket.requiredApprovals} ✓</span>
                </div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>
                  Requested by {ticket.createdByName} • {ticket.createdAt ? new Date(ticket.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}
                </div>
                {ticket.description && <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>{ticket.description}</div>}

                {/* Expanded view */}
                {expandedTicket === ticket.ticketId && (
                  <div style={{ padding: '10px 12px', background: 'rgba(0,96,169,0.05)', borderRadius: 6, margin: '8px 0', border: '1px solid rgba(0,96,169,0.1)' }}>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                      {ticket.description || `Remediation requested for ${ticket.resourceName}. Approving will revert the resource to its golden baseline configuration.`}
                    </div>
                    <button onClick={() => handleDetailedView(ticket)}
                      style={{ marginTop: 8, padding: '5px 12px', borderRadius: 4, border: '1px solid rgba(0,96,169,0.3)', background: 'rgba(0,96,169,0.1)', color: '#60a5fa', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                      Detailed View →
                    </button>
                    {isApprover && (
                      <div style={{ marginTop: 8 }}>
                        <input type="text" placeholder="Reason (optional)" value={rejectReason} onChange={e => setRejectReason(e.target.value)}
                          style={{ width: '100%', padding: '6px 10px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.04)', color: '#fff', fontSize: 12 }} />
                      </div>
                    )}
                  </div>
                )}

                {/* Actions */}
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button onClick={() => setExpandedTicket(expandedTicket === ticket.ticketId ? null : ticket.ticketId)}
                    style={{ padding: '5px 10px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: 'rgba(255,255,255,0.6)', fontSize: 11, cursor: 'pointer' }}>
                    {expandedTicket === ticket.ticketId ? 'Collapse' : 'Expand'}
                  </button>
                  {isApprover && (
                    <>
                      <button onClick={() => handleApprove(ticket.ticketId)} disabled={actionLoading === ticket.ticketId}
                        style={{ padding: '5px 12px', borderRadius: 4, border: 'none', background: '#10b981', color: '#fff', fontSize: 11, fontWeight: 600, cursor: 'pointer', opacity: actionLoading === ticket.ticketId ? 0.5 : 1 }}>
                        ✓ Approve
                      </button>
                      <button onClick={() => handleReject(ticket.ticketId)} disabled={actionLoading === ticket.ticketId}
                        style={{ padding: '5px 12px', borderRadius: 4, border: 'none', background: '#ef4444', color: '#fff', fontSize: 11, fontWeight: 600, cursor: 'pointer', opacity: actionLoading === ticket.ticketId ? 0.5 : 1 }}>
                        ✗ Reject
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))
          )}

          {/* Notifications */}
          {activeTab === 'notifications' && (<>
            {notifications.some(n => !n.read) && (
              <button onClick={() => notifications.filter(n => !n.read).forEach(n => handleMarkRead(n.rowKey))}
                style={{ marginBottom: 10, padding: '5px 12px', borderRadius: 4, border: '1px solid rgba(255,255,255,0.1)', background: 'transparent', color: '#60a5fa', fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                Mark all as read
              </button>
            )}
            {notifications.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 32, color: 'rgba(255,255,255,0.3)', fontSize: 13 }}>No notifications</div>
            ) : notifications.map(notification => (
              <div key={notification.rowKey} onClick={() => handleMarkRead(notification.rowKey)}
                style={{ ...cardStyle, cursor: 'pointer', opacity: notification.read ? 0.6 : 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {!notification.read && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#0060a9', flexShrink: 0 }} />}
                  <span style={{ fontSize: 12, color: 'var(--text-primary)', flex: 1 }}>{notification.message}</span>
                </div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', marginTop: 4 }}>
                  {notification.createdAt ? new Date(notification.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}
                </div>
              </div>
            ))}
          </>)}

          {/* My Requests */}
          {activeTab === 'myRequests' && (
            myTickets.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 32, color: 'rgba(255,255,255,0.3)', fontSize: 13 }}>No requests yet</div>
            ) : myTickets.map(ticket => (
              <div key={ticket.ticketId} style={cardStyle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)' }}>{ticket.resourceName}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600,
                    color: ticket.status === 'approved' ? '#10b981' : ticket.status === 'rejected' ? '#ef4444' : '#f59e0b' }}>
                    {ticket.status === 'pending' ? `⏳ ${ticket.currentApprovals}/${ticket.requiredApprovals} approved` :
                     ticket.status === 'approved' ? '✓ Approved & Executed' : '✗ Rejected'}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>
                  {ticket.createdAt ? new Date(ticket.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  )
}
