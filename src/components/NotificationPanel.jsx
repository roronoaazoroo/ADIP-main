// ============================================================
// FILE: src/components/NotificationPanel.jsx
// ROLE: Slide-out panel from NavBar bell — Notifications + Pending Approvals
// ============================================================
import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchNotifications, markNotificationRead, getCurrentUser } from '../services/authService'
import { fetchTickets, approveTicket, rejectTicket } from '../services/api'
import { getSocket } from '../services/socketSingleton'
import './NotificationPanel.css'

const SEVERITY_COLOR = {
  critical: '#ef4444',
  high:     '#f97316',
  medium:   '#f59e0b',
  low:      '#facc15',
}

export default function NotificationPanel({ isOpen, onClose }) {
  const navigate = useNavigate()
  const [activeTab, setActiveTab]       = useState('approvals')
  const [notifications, setNotifications] = useState([])
  const [tickets, setTickets]           = useState([])
  const [expandedTicket, setExpandedTicket] = useState(null)
  const [rejectReason, setRejectReason] = useState('')
  const [actionLoading, setActionLoading] = useState(null)

  const currentUser  = getCurrentUser()
  const sessionUser  = (() => { try { return JSON.parse(sessionStorage.getItem('user') || '{}') } catch { return {} } })()
  const effectiveRole = sessionUser?.role || currentUser?.role
  const isApprover   = effectiveRole === 'admin' || effectiveRole === 'approver'

  useEffect(() => {
    if (!isOpen) return
    fetchNotifications().then(setNotifications).catch(() => {})
    fetchTickets().then(setTickets).catch(() => {})
  }, [isOpen])

  // Real-time updates via Socket.IO
  useEffect(() => {
    const socket = getSocket()
    if (!socket) return
    const handleNewNotification = () => fetchNotifications().then(setNotifications).catch(() => {})
    const handleTicketUpdate    = () => fetchTickets().then(setTickets).catch(() => {})
    socket.on('newNotification', handleNewNotification)
    socket.on('ticketUpdate',    handleTicketUpdate)
    socket.on('roleChange',      handleNewNotification)
    return () => {
      socket.off('newNotification', handleNewNotification)
      socket.off('ticketUpdate',    handleTicketUpdate)
      socket.off('roleChange',      handleNewNotification)
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
      setTickets(prev => prev.map(t =>
        t.ticketId === ticketId ? { ...t, currentApprovals: result.currentApprovals, status: result.status } : t
      ))
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
      state: {
        subscriptionId: ticket.subscriptionId,
        resourceGroupId: ticket.resourceGroupId,
        resourceId: ticket.resourceId,
        resourceName: ticket.resourceName,
      },
    })
  }

  const unreadCount    = notifications.filter(n => !n.read).length
  const pendingTickets = tickets.filter(t => t.status === 'pending' && (isApprover || t.createdBy === currentUser?.userId))
  const myTickets      = tickets.filter(t => t.createdBy === currentUser?.userId)

  if (!isOpen) return null

  const fmtDate = (d) =>
    d ? new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''

  return (
    <>
      <div className="np-overlay" onClick={onClose} />

      <div className="np-panel" role="dialog" aria-label="Notifications">
        {/* Header */}
        <div className="np-header">
          <span className="np-title">Notifications</span>
          <button className="np-close-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {/* Tabs */}
        <div className="np-tabs" role="tablist">
          <button
            className={`np-tab ${activeTab === 'approvals' ? 'np-tab--active' : ''}`}
            onClick={() => setActiveTab('approvals')}
            role="tab"
            aria-selected={activeTab === 'approvals'}
          >
            Approvals
            {pendingTickets.length > 0 && (
              <span className="np-tab-badge np-tab-badge--red">{pendingTickets.length}</span>
            )}
          </button>

          <button
            className={`np-tab ${activeTab === 'notifications' ? 'np-tab--active' : ''}`}
            onClick={() => setActiveTab('notifications')}
            role="tab"
            aria-selected={activeTab === 'notifications'}
          >
            Activity
            {unreadCount > 0 && (
              <span className="np-tab-badge np-tab-badge--blue">{unreadCount}</span>
            )}
          </button>

          <button
            className={`np-tab ${activeTab === 'myRequests' ? 'np-tab--active' : ''}`}
            onClick={() => setActiveTab('myRequests')}
            role="tab"
            aria-selected={activeTab === 'myRequests'}
          >
            My Requests
          </button>
        </div>

        {/* Content */}
        <div className="np-content" role="tabpanel">

          {/* ── Pending Approvals ── */}
          {activeTab === 'approvals' && (
            pendingTickets.length === 0 ? (
              <div className="np-empty">
                <div className="np-empty-icon">✅</div>
                No pending approvals
              </div>
            ) : pendingTickets.map(ticket => (
              <div key={ticket.ticketId} className="np-card">
                <div className="np-card-row">
                  <span className="np-resource-name">{ticket.resourceName}</span>
                  <span
                    className="np-severity"
                    style={{
                      background: `${SEVERITY_COLOR[ticket.severity] || '#64748b'}18`,
                      color: SEVERITY_COLOR[ticket.severity] || '#64748b',
                    }}
                  >
                    {ticket.severity}
                  </span>
                  <span className="np-approval-count">
                    {ticket.currentApprovals}/{ticket.requiredApprovals} ✓
                  </span>
                </div>

                <div className="np-meta">
                  Requested by {ticket.createdByName} • {fmtDate(ticket.createdAt)}
                </div>

                {ticket.description && (
                  <div className="np-description">{ticket.description}</div>
                )}

                {/* Expanded detail */}
                {expandedTicket === ticket.ticketId && (
                  <div className="np-expanded">
                    <div className="np-expanded-desc">
                      {ticket.description ||
                        `Remediation requested for ${ticket.resourceName}. Approving will revert the resource to its golden baseline configuration.`}
                    </div>
                    <button className="np-detailed-btn" onClick={() => handleDetailedView(ticket)}>
                      Detailed View →
                    </button>
                    {isApprover && (
                      <input
                        type="text"
                        className="np-reject-input"
                        placeholder="Rejection reason (optional)"
                        value={rejectReason}
                        onChange={e => setRejectReason(e.target.value)}
                      />
                    )}
                  </div>
                )}

                {/* Actions */}
                <div className="np-actions">
                  <button
                    className="np-btn np-btn--ghost"
                    onClick={() => setExpandedTicket(expandedTicket === ticket.ticketId ? null : ticket.ticketId)}
                  >
                    {expandedTicket === ticket.ticketId ? 'Collapse' : 'Expand'}
                  </button>

                  {isApprover && (
                    <>
                      <button
                        className="np-btn np-btn--approve"
                        onClick={() => handleApprove(ticket.ticketId)}
                        disabled={actionLoading === ticket.ticketId}
                      >
                        ✓ Approve
                      </button>
                      <button
                        className="np-btn np-btn--reject"
                        onClick={() => handleReject(ticket.ticketId)}
                        disabled={actionLoading === ticket.ticketId}
                      >
                        ✗ Reject
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))
          )}

          {/* ── Activity / Notifications ── */}
          {activeTab === 'notifications' && (<>
            {notifications.some(n => !n.read) && (
              <button
                className="np-mark-all-btn"
                onClick={() => notifications.filter(n => !n.read).forEach(n => handleMarkRead(n.rowKey))}
              >
                Mark all as read
              </button>
            )}

            {notifications.length === 0 ? (
              <div className="np-empty">
                <div className="np-empty-icon">🔔</div>
                No notifications yet
              </div>
            ) : notifications.map(notification => (
              <div
                key={notification.rowKey}
                className={`np-card np-card--clickable ${notification.read ? 'np-card--faded' : 'np-card--unread'}`}
                onClick={() => handleMarkRead(notification.rowKey)}
              >
                <div className="np-card-row">
                  {!notification.read && <span className="np-unread-dot" />}
                  <span className="np-notification-text">{notification.message}</span>
                </div>
                <div className="np-meta">{fmtDate(notification.createdAt)}</div>
              </div>
            ))}
          </>)}

          {/* ── My Requests ── */}
          {activeTab === 'myRequests' && (
            myTickets.length === 0 ? (
              <div className="np-empty">
                <div className="np-empty-icon">📋</div>
                No requests submitted yet
              </div>
            ) : myTickets.map(ticket => (
              <div key={ticket.ticketId} className="np-card">
                <div className="np-card-row">
                  <span className="np-resource-name">{ticket.resourceName}</span>
                  <span
                    className={`np-status ${
                      ticket.status === 'approved' ? 'np-status--approved' :
                      ticket.status === 'rejected' ? 'np-status--rejected' :
                      'np-status--pending'
                    }`}
                  >
                    {ticket.status === 'pending'
                      ? `⏳ ${ticket.currentApprovals}/${ticket.requiredApprovals} approved`
                      : ticket.status === 'approved'
                        ? '✓ Approved & Executed'
                        : '✗ Rejected'}
                  </span>
                </div>
                <div className="np-meta">{fmtDate(ticket.createdAt)}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  )
}
