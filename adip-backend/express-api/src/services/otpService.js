// ============================================================
// FILE: adip-backend/express-api/src/services/otpService.js
// ROLE: OTP generation, storage (Azure Table), verification, email delivery
//
// - generateOtp(email) → stores 6-digit code with 5min TTL, sends via ACS
// - verifyOtp(email, code) → returns true/false, deletes on success
// - Rate limited: max 3 attempts per email per 15 minutes
// ============================================================
'use strict'
const crypto = require('crypto')
const { TableClient } = require('@azure/data-tables')
const { EmailClient } = require('@azure/communication-email')

function otpTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'otpCodes')
}

const rateLimitMap = new Map() // email → { count, resetAt }

function checkRateLimit(email) {
  const entry = rateLimitMap.get(email)
  const now = Date.now()
  if (!entry || entry.resetAt < now) {
    rateLimitMap.set(email, { count: 1, resetAt: now + 15 * 60 * 1000 })
    return true
  }
  if (entry.count >= 3) return false
  entry.count++
  return true
}

async function generateOtp(email) {
  if (!checkRateLimit(email)) {
    throw new Error('Too many OTP requests. Please wait 15 minutes.')
  }

  const code = crypto.randomInt(100000, 999999).toString()
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()

  // Store in table
  await otpTable().upsertEntity({
    partitionKey: 'otp',
    rowKey: email.toLowerCase(),
    code,
    expiresAt,
    attempts: 0,
  }, 'Replace')

  // Send via ACS email
  const connectionString = process.env.COMMS_CONNECTION_STRING
  const senderAddress = process.env.SENDER_ADDRESS
  if (connectionString && senderAddress) {
    const emailClient = new EmailClient(connectionString)
    await emailClient.beginSend({
      senderAddress,
      content: {
        subject: 'ADIP — Your Verification Code',
        html: `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:400px;margin:0 auto;padding:32px">
          <h2 style="color:#0f172a;margin:0 0 16px">Verification Code</h2>
          <p style="color:#64748b;font-size:14px">Enter this code to verify your email:</p>
          <div style="background:#f1f5f9;border-radius:8px;padding:16px;text-align:center;margin:20px 0">
            <span style="font-size:32px;font-weight:700;letter-spacing:8px;color:#0f172a">${code}</span>
          </div>
          <p style="color:#94a3b8;font-size:12px">This code expires in 5 minutes. If you didn't request this, ignore this email.</p>
          <p style="color:#94a3b8;font-size:11px;margin-top:24px">— Azure Drift Intelligence Platform</p>
        </div>`,
        plainText: `Your ADIP verification code is: ${code}. It expires in 5 minutes.`,
      },
      recipients: { to: [{ address: email }] },
    })
    console.log('[otpService] OTP sent to:', email)
  } else {
    // Dev mode — log to console
    console.log(`[otpService] DEV MODE — OTP for ${email}: ${code}`)
  }

  return { sent: true }
}

async function verifyOtp(email, code) {
  try {
    const entity = await otpTable().getEntity('otp', email.toLowerCase())

    // Check expiry
    if (new Date(entity.expiresAt) < new Date()) {
      await otpTable().deleteEntity('otp', email.toLowerCase()).catch(() => {})
      throw new Error('OTP expired. Please request a new one.')
    }

    // Check attempts
    if ((entity.attempts || 0) >= 5) {
      await otpTable().deleteEntity('otp', email.toLowerCase()).catch(() => {})
      throw new Error('Too many failed attempts. Please request a new OTP.')
    }

    // Verify code
    if (entity.code !== code) {
      await otpTable().upsertEntity({ ...entity, attempts: (entity.attempts || 0) + 1 }, 'Replace')
      throw new Error('Invalid code. Please try again.')
    }

    // Success — delete OTP
    await otpTable().deleteEntity('otp', email.toLowerCase()).catch(() => {})
    return true
  } catch (error) {
    if (error.statusCode === 404) throw new Error('No OTP found. Please request one first.')
    throw error
  }
}

module.exports = { generateOtp, verifyOtp }
