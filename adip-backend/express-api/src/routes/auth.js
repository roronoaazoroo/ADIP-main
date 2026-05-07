// ============================================================
// FILE: adip-backend/express-api/src/routes/auth.js
// ROLE: Authentication & organization management endpoints
//
// POST /api/auth/create-org   — create organization + admin user
// POST /api/auth/join-org     — join existing org as member
// POST /api/auth/login        — sign in, returns JWT
// GET  /api/auth/me           — returns current user + org info
// ============================================================
'use strict'
const router  = require('express').Router()
const bcrypt  = require('bcryptjs')
const jwt     = require('jsonwebtoken')
const crypto  = require('crypto')
const { TableClient } = require('@azure/data-tables')

const JWT_SECRET = process.env.JWT_SECRET || 'adip-dev-secret-change-in-production'
const JWT_EXPIRY = '24h'

function organizationsTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'organizations')
}

function orgMembersTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'orgMembers')
}

function generateAuthToken(user) {
  return jwt.sign(
    { userId: user.userId, orgId: user.orgId, role: user.role, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  )
}

// POST /api/auth/create-org
router.post('/auth/create-org', async (req, res) => {
  console.log('[POST /auth/create-org] starts')
  const { organizationName, name, email, password, subscriptionId, retentionDays = 30, requiredApprovals = 2 } = req.body

  if (!organizationName || !name || !email || !password || !subscriptionId) {
    return res.status(400).json({ error: 'organizationName, name, email, password, subscriptionId required' })
  }

  try {
    const orgId = crypto.randomUUID().slice(0, 8)
    const organizationToken = `ADIP-${orgId.toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`
    const userId = crypto.randomUUID().slice(0, 12)
    const passwordHash = await bcrypt.hash(password, 10)

    await organizationsTable().upsertEntity({
      partitionKey: orgId,
      rowKey: orgId,
      organizationName,
      organizationToken,
      adminUserId: userId,
      subscriptionId,
      retentionDays,
      requiredApprovals,
      createdAt: new Date().toISOString(),
    }, 'Replace')

    await orgMembersTable().upsertEntity({
      partitionKey: orgId,
      rowKey: userId,
      email: email.toLowerCase(),
      name,
      role: 'admin',
      passwordHash,
      joinedAt: new Date().toISOString(),
    }, 'Replace')

    const token = generateAuthToken({ userId, orgId, role: 'admin', email, name })
    res.status(201).json({ token, organizationToken, orgId, userId, role: 'admin', organizationName, subscriptionId })
    console.log('[POST /auth/create-org] ends — orgId:', orgId)
  } catch (error) {
    console.log('[POST /auth/create-org] error:', error.message)
    res.status(500).json({ error: error.message })
  }
})

// GET /api/auth/organizations — public, returns org list for dropdown
router.get('/auth/organizations', async (req, res) => {
  try {
    const organizations = []
    for await (const entity of organizationsTable().listEntities()) {
      if (entity.organizationName) organizations.push({ orgId: entity.partitionKey, organizationName: entity.organizationName })
    }
    res.json(organizations)
  } catch (error) { res.status(500).json({ error: error.message }) }
})

// POST /api/auth/join-org
router.post('/auth/join-org', async (req, res) => {
  console.log('[POST /auth/join-org] starts')
  const { orgId, name, email, password } = req.body

  if (!orgId || !name || !email || !password) {
    return res.status(400).json({ error: 'orgId, name, email, password required' })
  }

  try {
    let organization = null
    try { organization = await organizationsTable().getEntity(orgId, orgId) } catch {}
    if (!organization) return res.status(404).json({ error: 'Organization not found' })

    const orgId = organization.partitionKey

    for await (const entity of orgMembersTable().listEntities({ queryOptions: { filter: `PartitionKey eq '${orgId}'` } })) {
      if (entity.email === email.toLowerCase()) {
        return res.status(409).json({ error: 'Email already registered in this organization' })
      }
    }

    const userId = crypto.randomUUID().slice(0, 12)
    const passwordHash = await bcrypt.hash(password, 10)

    await orgMembersTable().upsertEntity({
      partitionKey: orgId,
      rowKey: userId,
      email: email.toLowerCase(),
      name,
      role: 'requestor',
      passwordHash,
      joinedAt: new Date().toISOString(),
    }, 'Replace')

    const token = generateAuthToken({ userId, orgId, role: 'requestor', email, name })
    res.status(201).json({ token, orgId, userId, role: 'requestor', organizationName: organization.organizationName, subscriptionId: organization.subscriptionId })
    console.log('[POST /auth/join-org] ends — userId:', userId)
  } catch (error) {
    console.log('[POST /auth/join-org] error:', error.message)
    res.status(500).json({ error: error.message })
  }
})

// POST /api/auth/login
router.post('/auth/login', async (req, res) => {
  console.log('[POST /auth/login] starts')
  const { email, password } = req.body

  if (!email || !password) {
    return res.status(400).json({ error: 'email and password required' })
  }

  try {
    let member = null
    for await (const entity of orgMembersTable().listEntities()) {
      if (entity.email === email.toLowerCase()) { member = entity; break }
    }
    if (!member) return res.status(401).json({ error: 'Invalid email or password' })

    const isValid = await bcrypt.compare(password, member.passwordHash)
    if (!isValid) return res.status(401).json({ error: 'Invalid email or password' })

    const orgId = member.partitionKey
    let organization = null
    try { organization = await organizationsTable().getEntity(orgId, orgId) } catch {}

    const token = generateAuthToken({ userId: member.rowKey, orgId, role: member.role, email: member.email, name: member.name })
    res.json({ token, userId: member.rowKey, orgId, role: member.role, name: member.name, organizationName: organization?.organizationName || '', subscriptionId: organization?.subscriptionId || '' })
    console.log('[POST /auth/login] ends — userId:', member.rowKey)
  } catch (error) {
    console.log('[POST /auth/login] error:', error.message)
    res.status(500).json({ error: error.message })
  }
})

// GET /api/auth/me
router.get('/auth/me', (req, res) => {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' })
  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET)
    res.json(decoded)
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
})

module.exports = router
module.exports.JWT_SECRET = JWT_SECRET
