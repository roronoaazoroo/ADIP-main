// ============================================================
// FILE: adip-backend/express-api/src/routes/orgManagement.js
// ROLE: Organization member management + notifications
//
// GET  /api/org/members         — list org members
// PUT  /api/org/members/:userId — update member role
// GET  /api/org/notifications   — list notifications for current user
// PUT  /api/org/notifications/:rowKey — mark as read
// ============================================================
'use strict'
const router = require('express').Router()
const { TableClient } = require('@azure/data-tables')
const jwt = require('jsonwebtoken')

const JWT_SECRET = process.env.JWT_SECRET || 'adip-dev-secret-change-in-production'

function membersTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'orgMembers')
}
function notificationsTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'notifications')
}

// Helper: extract user from JWT
function getUser(req) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) return null
  try { return jwt.verify(authHeader.slice(7), JWT_SECRET) } catch { return null }
}

// Helper: create notification for a user
async function createNotification(orgId, recipientUserId, message, type) {
  const rowKey = `${recipientUserId}-${Date.now()}`
  await notificationsTable().upsertEntity({
    partitionKey: orgId,
    rowKey,
    recipientUserId,
    message,
    type,
    read: false,
    createdAt: new Date().toISOString(),
  }, 'Replace').catch(() => {})
}

// Helper: notify all members of an org
async function notifyAllMembers(orgId, message, type, excludeUserId = null) {
  for await (const member of membersTable().listEntities({ queryOptions: { filter: `PartitionKey eq '${orgId}'` } })) {
    if (member.rowKey === excludeUserId) continue
    await createNotification(orgId, member.rowKey, message, type)
  }
}

// GET /api/org/members
router.get('/org/members', async (req, res) => {
  const user = getUser(req)
  if (!user) return res.status(401).json({ error: 'Authentication required' })

  try {
    const members = []
    for await (const entity of membersTable().listEntities({ queryOptions: { filter: `PartitionKey eq '${user.orgId}'` } })) {
      members.push({ userId: entity.rowKey, email: entity.email, name: entity.name, role: entity.role, joinedAt: entity.joinedAt })
    }
    res.json(members)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// PUT /api/org/members/:userId — update role (admin only)
router.put('/org/members/:userId', async (req, res) => {
  const user = getUser(req)
  if (!user) return res.status(401).json({ error: 'Authentication required' })
  if (user.role !== 'admin') return res.status(403).json({ error: 'Only admin can manage members' })

  const { userId } = req.params
  const { role } = req.body
  if (!role || !['approver', 'requestor'].includes(role)) {
    return res.status(400).json({ error: 'role must be "approver" or "requestor"' })
  }

  try {
    const entity = await membersTable().getEntity(user.orgId, userId)
    await membersTable().upsertEntity({ ...entity, role }, 'Replace')

    // Notify all members about role change
    const promotedName = entity.name || entity.email
    if (role === 'approver') {
      await notifyAllMembers(user.orgId, `${promotedName} is now an approver`, 'role_change', userId)
    }

    res.json({ updated: true, userId, role })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// GET /api/org/notifications
router.get('/org/notifications', async (req, res) => {
  const user = getUser(req)
  if (!user) return res.status(401).json({ error: 'Authentication required' })

  try {
    const notifications = []
    for await (const entity of notificationsTable().listEntities({ queryOptions: { filter: `PartitionKey eq '${user.orgId}'` } })) {
      if (entity.recipientUserId !== user.userId) continue
      notifications.push({ rowKey: entity.rowKey, message: entity.message, type: entity.type, read: entity.read, createdAt: entity.createdAt })
    }
    notifications.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    res.json(notifications.slice(0, 50))
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// PUT /api/org/notifications/:rowKey — mark as read
router.put('/org/notifications/:rowKey', async (req, res) => {
  const user = getUser(req)
  if (!user) return res.status(401).json({ error: 'Authentication required' })

  try {
    const entity = await notificationsTable().getEntity(user.orgId, req.params.rowKey)
    await notificationsTable().upsertEntity({ ...entity, read: true }, 'Replace')
    res.json({ marked: true })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

module.exports = router
module.exports.createNotification = createNotification
module.exports.notifyAllMembers = notifyAllMembers
