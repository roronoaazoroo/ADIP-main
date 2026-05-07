// ============================================================
// FILE: adip-backend/express-api/src/routes/approvalTickets.js
// ROLE: Multi-approval ticket system for remediations
//
// POST   /api/tickets              — create ticket (requestor)
// GET    /api/tickets              — list tickets for org
// POST   /api/tickets/:id/approve  — approve a ticket (approver/admin)
// POST   /api/tickets/:id/reject   — reject a ticket (approver/admin)
// GET    /api/tickets/:id          — get single ticket details
// ============================================================
'use strict'
const router = require('express').Router()
const { TableClient } = require('@azure/data-tables')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')

const JWT_SECRET = process.env.JWT_SECRET || 'adip-dev-secret-change-in-production'

function ticketsTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'approvalTickets')
}
function organizationsTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'organizations')
}
function membersTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'orgMembers')
}

function getUser(req) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) return null
  try { return jwt.verify(authHeader.slice(7), JWT_SECRET) } catch { return null }
}

// Get required approvals for a resource (org default or per-resource override)
async function getRequiredApprovals(orgId, resourceId) {
  try {
    const org = await organizationsTable().getEntity(orgId, orgId)
    return org.requiredApprovals || 2
  } catch { return 2 }
}

// POST /api/tickets — create a remediation ticket
router.post('/tickets', async (req, res) => {
  console.log('[POST /tickets] starts')
  const user = getUser(req)
  if (!user) return res.status(401).json({ error: 'Authentication required' })

  const { subscriptionId, resourceGroupId, resourceId, severity, description } = req.body
  if (!subscriptionId || !resourceGroupId || !resourceId) {
    return res.status(400).json({ error: 'subscriptionId, resourceGroupId, resourceId required' })
  }

  try {
    const requiredApprovals = await getRequiredApprovals(user.orgId, resourceId)
    const ticketId = crypto.randomUUID().slice(0, 12)

    const ticket = {
      partitionKey: user.orgId,
      rowKey: ticketId,
      ticketId,
      subscriptionId,
      resourceGroupId,
      resourceId,
      resourceName: resourceId.split('/').pop(),
      severity: severity || 'medium',
      description: description || '',
      requiredApprovals,
      currentApprovals: 0,
      approvers: JSON.stringify([]),
      status: 'pending',
      createdBy: user.userId,
      createdByName: user.name || user.email,
      createdAt: new Date().toISOString(),
    }

    await ticketsTable().upsertEntity(ticket, 'Replace')

    // Notify all approvers in the org
    const { createNotification } = require('./orgManagement')
    for await (const member of membersTable().listEntities({ queryOptions: { filter: `PartitionKey eq '${user.orgId}'` } })) {
      if (member.role === 'approver' || member.role === 'admin') {
        await createNotification(user.orgId, member.rowKey, `New remediation request for ${ticket.resourceName} by ${user.name}`, 'ticket_created')
      }
    }

    res.status(201).json({ ticketId, status: 'pending', requiredApprovals, currentApprovals: 0 })
    console.log('[POST /tickets] ends — ticketId:', ticketId)
  } catch (error) {
    console.log('[POST /tickets] error:', error.message)
    res.status(500).json({ error: error.message })
  }
})

// GET /api/tickets — list all tickets for the org
router.get('/tickets', async (req, res) => {
  const user = getUser(req)
  if (!user) return res.status(401).json({ error: 'Authentication required' })

  const { status } = req.query
  try {
    const tickets = []
    let filter = `PartitionKey eq '${user.orgId}'`
    if (status) filter += ` and status eq '${status}'`

    for await (const entity of ticketsTable().listEntities({ queryOptions: { filter } })) {
      tickets.push({
        ticketId: entity.ticketId,
        resourceId: entity.resourceId,
        resourceName: entity.resourceName,
        severity: entity.severity,
        description: entity.description,
        requiredApprovals: entity.requiredApprovals,
        currentApprovals: entity.currentApprovals,
        approvers: JSON.parse(entity.approvers || '[]'),
        status: entity.status,
        createdBy: entity.createdBy,
        createdByName: entity.createdByName,
        createdAt: entity.createdAt,
        resolvedAt: entity.resolvedAt,
      })
    }
    tickets.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    res.json(tickets)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// GET /api/tickets/:id
router.get('/tickets/:id', async (req, res) => {
  const user = getUser(req)
  if (!user) return res.status(401).json({ error: 'Authentication required' })

  try {
    const entity = await ticketsTable().getEntity(user.orgId, req.params.id)
    res.json({
      ticketId: entity.ticketId,
      resourceId: entity.resourceId,
      resourceName: entity.resourceName,
      resourceGroupId: entity.resourceGroupId,
      subscriptionId: entity.subscriptionId,
      severity: entity.severity,
      description: entity.description,
      requiredApprovals: entity.requiredApprovals,
      currentApprovals: entity.currentApprovals,
      approvers: JSON.parse(entity.approvers || '[]'),
      status: entity.status,
      createdBy: entity.createdBy,
      createdByName: entity.createdByName,
      createdAt: entity.createdAt,
      resolvedAt: entity.resolvedAt,
    })
  } catch {
    res.status(404).json({ error: 'Ticket not found' })
  }
})

// POST /api/tickets/:id/approve
router.post('/tickets/:id/approve', async (req, res) => {
  console.log('[POST /tickets/:id/approve] starts')
  const user = getUser(req)
  if (!user) return res.status(401).json({ error: 'Authentication required' })
  // Check live role from table (JWT may be stale after role change)
  let liveRole = user.role
  try {
    const memberEntity = await membersTable().getEntity(user.orgId, user.userId).catch(() => null)
    if (memberEntity) liveRole = memberEntity.role
  } catch {}
  if (liveRole === 'requestor') return res.status(403).json({ error: 'Only approvers can approve tickets' })

  try {
    const entity = await ticketsTable().getEntity(user.orgId, req.params.id)
    if (entity.status !== 'pending') return res.status(400).json({ error: 'Ticket is not pending' })

    const approvers = JSON.parse(entity.approvers || '[]')
    if (approvers.find(a => a.userId === user.userId)) return res.status(400).json({ error: 'Already approved by you' })

    approvers.push({ userId: user.userId, name: user.name, decidedAt: new Date().toISOString() })
    const currentApprovals = approvers.length
    const thresholdMet = currentApprovals >= entity.requiredApprovals

    const updatedEntity = {
      ...entity,
      approvers: JSON.stringify(approvers),
      currentApprovals,
      status: thresholdMet ? 'approved' : 'pending',
      resolvedAt: thresholdMet ? new Date().toISOString() : undefined,
    }
    await ticketsTable().upsertEntity(updatedEntity, 'Replace')

    // Notify requestor of progress
    const { createNotification } = require('./orgManagement')
    await createNotification(user.orgId, entity.createdBy, `${user.name} approved your remediation for ${entity.resourceName} (${currentApprovals}/${entity.requiredApprovals})`, 'ticket_approved')

    // If threshold met, execute remediation
    if (thresholdMet) {
      console.log('[approve] threshold met — executing remediation for', entity.resourceName)
      try {
        const fetch = require('node-fetch')
        const baseUrl = (process.env.EXPRESS_API_URL || 'http://localhost:3001').replace(/\/api$/, '')
        await fetch(`${baseUrl}/api/remediate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscriptionId: entity.subscriptionId, resourceGroupId: entity.resourceGroupId, resourceId: entity.resourceId }),
        })
        await createNotification(user.orgId, entity.createdBy, `Remediation executed for ${entity.resourceName}`, 'ticket_executed')
      } catch (execError) {
        console.log('[approve] execution error:', execError.message)
      }
    }

    // Emit via Socket.IO for real-time update
    if (global.io) {
      global.io.emit('ticketUpdate', { ticketId: entity.ticketId, currentApprovals, requiredApprovals: entity.requiredApprovals, status: updatedEntity.status })
    }

    res.json({ ticketId: entity.ticketId, currentApprovals, requiredApprovals: entity.requiredApprovals, status: updatedEntity.status })
    console.log('[POST /tickets/:id/approve] ends')
  } catch (error) {
    console.log('[POST /tickets/:id/approve] error:', error.message)
    res.status(500).json({ error: error.message })
  }
})

// POST /api/tickets/:id/reject
router.post('/tickets/:id/reject', async (req, res) => {
  console.log('[POST /tickets/:id/reject] starts')
  const user = getUser(req)
  if (!user) return res.status(401).json({ error: 'Authentication required' })
  let liveRoleReject = user.role
  try {
    const memberEntity = await membersTable().getEntity(user.orgId, user.userId).catch(() => null)
    if (memberEntity) liveRoleReject = memberEntity.role
  } catch {}
  if (liveRoleReject === 'requestor') return res.status(403).json({ error: 'Only approvers can reject tickets' })

  const { reason } = req.body || {}

  try {
    const entity = await ticketsTable().getEntity(user.orgId, req.params.id)
    if (entity.status !== 'pending') return res.status(400).json({ error: 'Ticket is not pending' })

    await ticketsTable().upsertEntity({
      ...entity,
      status: 'rejected',
      rejectedBy: user.name,
      rejectionReason: reason || '',
      resolvedAt: new Date().toISOString(),
    }, 'Replace')

    // Notify requestor
    const { createNotification } = require('./orgManagement')
    await createNotification(user.orgId, entity.createdBy, `Remediation for ${entity.resourceName} rejected by ${user.name}${reason ? ': ' + reason : ''}`, 'ticket_rejected')

    if (global.io) {
      global.io.emit('ticketUpdate', { ticketId: entity.ticketId, status: 'rejected' })
    }

    res.json({ ticketId: entity.ticketId, status: 'rejected' })
    console.log('[POST /tickets/:id/reject] ends')
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

module.exports = router
