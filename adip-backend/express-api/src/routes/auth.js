// ============================================================
// FILE: adip-backend/express-api/src/routes/auth.js
// ROLE: Authentication with OTP verification
//
// POST /api/auth/send-otp        — sends OTP to email
// POST /api/auth/verify-otp      — verifies OTP code
// POST /api/auth/create-org      — create org (requires verified email)
// POST /api/auth/join-org        — join org via invite code (requires verified email)
// POST /api/auth/login           — sign in with email + password
// GET  /api/auth/organizations   — public, returns org list (for display only)
// ============================================================
'use strict'
const router  = require('express').Router()
const bcrypt  = require('bcryptjs')
const jwt     = require('jsonwebtoken')
const crypto  = require('crypto')
const { TableClient } = require('@azure/data-tables')
const { generateOtp, verifyOtp } = require('../services/otpService')

const JWT_SECRET = process.env.JWT_SECRET || 'adip-dev-secret-change-in-production'
const JWT_EXPIRY = '24h'

function organizationsTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'organizations')
}
function orgAdminsTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'orgAdmins')
}
function orgMembersTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'orgMembers')
}

function generateAuthToken(user) {
  return jwt.sign(
    { userId: user.userId, orgId: user.orgId, role: user.role, email: user.email, name: user.name },
    JWT_SECRET, { expiresIn: JWT_EXPIRY }
  )
}

// Verified emails cache (in-memory, cleared on restart) — stores emails that passed OTP
const verifiedEmails = new Map() // email → expiresAt (10 min window to complete signup)

// POST /api/auth/send-otp
router.post('/auth/send-otp', async (req, res) => {
  const { email } = req.body
  if (!email) return res.status(400).json({ error: 'email required' })
  try {
    await generateOtp(email.toLowerCase())
    res.json({ sent: true, message: 'Verification code sent to your email' })
  } catch (error) {
    res.status(429).json({ error: error.message })
  }
})

// POST /api/auth/verify-otp
router.post('/auth/verify-otp', async (req, res) => {
  const { email, code } = req.body
  if (!email || !code) return res.status(400).json({ error: 'email and code required' })
  try {
    await verifyOtp(email.toLowerCase(), code)
    // Mark email as verified for 10 minutes
    verifiedEmails.set(email.toLowerCase(), Date.now() + 10 * 60 * 1000)
    res.json({ verified: true })
  } catch (error) {
    res.status(400).json({ error: error.message })
  }
})

function isEmailVerified(email) {
  const expiry = verifiedEmails.get(email.toLowerCase())
  if (!expiry || expiry < Date.now()) return false
  return true
}

// POST /api/auth/create-org
router.post('/auth/create-org', async (req, res) => {
  console.log('[POST /auth/create-org] starts')
  const { organizationName, name, email, password, subscriptionId, retentionDays = 30, requiredApprovals = 2, allowedDomain = '' } = req.body

  if (!organizationName || !name || !email || !password || !subscriptionId) {
    return res.status(400).json({ error: 'All fields required' })
  }
  if (!isEmailVerified(email)) {
    return res.status(403).json({ error: 'Email not verified. Please complete OTP verification first.' })
  }

  try {
    const orgId = crypto.randomUUID().slice(0, 8)
    const inviteCode = `ADIP-${crypto.randomBytes(2).toString('hex').toUpperCase()}`
    const userId = crypto.randomUUID().slice(0, 12)
    const passwordHash = password

    await organizationsTable().upsertEntity({
      partitionKey: orgId,
      rowKey: orgId,
      organizationName,
      inviteCode,
      adminUserId: userId,
      subscriptionId,
      retentionDays,
      requiredApprovals,
      allowedDomain: allowedDomain ? allowedDomain.toLowerCase().replace('@', '') : email.toLowerCase().split('@')[1] || '',
      createdAt: new Date().toISOString(),
    }, 'Replace')

    await orgAdminsTable().upsertEntity({
      partitionKey: orgId,
      rowKey: userId,
      email: email.toLowerCase(),
      name,
      role: 'admin',
      passwordHash,
      joinedAt: new Date().toISOString(),
    }, 'Replace')

    verifiedEmails.delete(email.toLowerCase())
    // Send invite code to admin's email
    try {
      const { EmailClient } = require('@azure/communication-email')
      const connStr = process.env.COMMS_CONNECTION_STRING
      const sender = process.env.SENDER_ADDRESS
      if (connStr && sender) {
        const emailClient = new EmailClient(connStr)
        await emailClient.beginSend({
          senderAddress: sender,
          content: {
            subject: `ADIP — Your Organization Invite Code`,
            html: `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:400px;margin:0 auto;padding:32px"><h2 style="color:#0f172a">Organization Created</h2><p style="color:#64748b">Share this invite code with your team:</p><div style="background:#f1f5f9;border-radius:8px;padding:16px;text-align:center;margin:20px 0"><span style="font-size:28px;font-weight:700;letter-spacing:4px;color:#0f172a">${inviteCode}</span></div><p style="color:#64748b;font-size:13px">Team members enter this code on the ADIP sign-up page to join <strong>${organizationName}</strong>.</p><p style="color:#94a3b8;font-size:11px;margin-top:24px">— Azure Drift Intelligence Platform</p></div>`,
            plainText: `Your ADIP organization invite code is: ${inviteCode}. Share it with team members to join ${organizationName}.`,
          },
          recipients: { to: [{ address: email }] },
        })
      }
    } catch { /* non-fatal */ }
    const token = generateAuthToken({ userId, orgId, role: 'admin', email, name })
    res.status(201).json({ token, inviteCode, orgId, userId, role: 'admin', organizationName, subscriptionId })
    console.log('[POST /auth/create-org] ends — orgId:', orgId, 'inviteCode:', inviteCode)
  } catch (error) {
    console.log('[POST /auth/create-org] error:', error.message)
    res.status(500).json({ error: error.message })
  }
})

// POST /api/auth/join-org
router.post('/auth/join-org', async (req, res) => {
  console.log('[POST /auth/join-org] starts')
  const { inviteCode, email, password } = req.body

  if (!inviteCode || !email || !password) {
    return res.status(400).json({ error: 'inviteCode, email, password required' })
  }
  if (!isEmailVerified(email)) {
    return res.status(403).json({ error: 'Email not verified. Please complete OTP verification first.' })
  }

  try {
    // Find org by invite code
    let organization = null
    for await (const entity of organizationsTable().listEntities()) {
      if (entity.inviteCode === inviteCode.toUpperCase()) { organization = entity; break }
    }
    if (!organization) return res.status(404).json({ error: 'Invalid invite code' })

    const orgId = organization.partitionKey

    // Check domain lock if configured
    if (organization.allowedDomain) {
      const emailDomain = email.toLowerCase().split('@')[1]
      if (emailDomain !== organization.allowedDomain) {
        return res.status(403).json({ error: `Only @${organization.allowedDomain} emails can join this organization` })
      }
    }

    // Check if email already exists
    for await (const entity of orgMembersTable().listEntities({ queryOptions: { filter: `PartitionKey eq '${orgId}'` } })) {
      if (entity.email === email.toLowerCase()) {
        return res.status(409).json({ error: 'Email already registered in this organization' })
      }
    }

    const userId = crypto.randomUUID().slice(0, 12)
    const passwordHash = password
    const name = email.split('@')[0]

    await orgMembersTable().upsertEntity({
      partitionKey: orgId,
      rowKey: userId,
      email: email.toLowerCase(),
      name,
      role: 'requestor',
      passwordHash,
      joinedAt: new Date().toISOString(),
    }, 'Replace')

    // Notify admin
    try {
      const { createNotification } = require('./orgManagement')
      if (createNotification && organization.adminUserId) {
        await createNotification(orgId, organization.adminUserId, `New member joined: ${name} (${email})`, 'member_joined')
      }
    } catch {}

    verifiedEmails.delete(email.toLowerCase())
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
  if (!email || !password) return res.status(400).json({ error: 'email and password required' })

  try {
    // Search orgAdmins first, then orgMembers
    let member = null
    try {
      for await (const entity of orgAdminsTable().listEntities()) {
        if (entity.email === email.toLowerCase()) {
          if (!member || (entity.joinedAt || '') > (member.joinedAt || '')) member = entity
        }
      }
    } catch { /* orgAdmins table may not exist yet */ }
    if (!member) {
      for await (const entity of orgMembersTable().listEntities()) {
        if (entity.email === email.toLowerCase()) {
          if (!member || (entity.joinedAt || '') > (member.joinedAt || '')) member = entity
        }
      }
    }
    if (!member) {
      console.log('[login] no member found for email:', email.toLowerCase())
      return res.status(401).json({ error: 'Invalid email or password' })
    }
    console.log('[login] found member:', member.email, 'role:', member.role, 'orgId:', member.partitionKey)

    if (password !== member.passwordHash) return res.status(401).json({ error: 'Invalid email or password' })

    const orgId = member.partitionKey
    let organization = null
    try { organization = await organizationsTable().getEntity(orgId, orgId) } catch {}

    const token = generateAuthToken({ userId: member.rowKey, orgId, role: member.role, email: member.email, name: member.name })
    res.json({ token, userId: member.rowKey, orgId, role: member.role, name: member.name, organizationName: organization?.organizationName || '', subscriptionId: organization?.subscriptionId || '' })
    console.log('[POST /auth/login] ends')
  } catch (error) {
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
  } catch { res.status(401).json({ error: 'Invalid or expired token' }) }
})

module.exports = router
module.exports.JWT_SECRET = JWT_SECRET
