// ============================================================
// FILE: adip-backend/express-api/src/middleware/authMiddleware.js
// ROLE: JWT verification + role-based authorization
// ============================================================
'use strict'
const jwt = require('jsonwebtoken')

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET && process.env.NODE_ENV === 'production') {
  console.error('[FATAL] JWT_SECRET environment variable is required in production')
  process.exit(1)
}
const SECRET = JWT_SECRET || 'adip-dev-secret-change-in-production'

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  try {
    req.user = jwt.verify(authHeader.slice(7), SECRET)
    next()
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' })
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient permissions' })
    next()
  }
}

// Optional auth — attaches user if token present, continues if not
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    try { req.user = jwt.verify(authHeader.slice(7), SECRET) } catch {}
  }
  next()
}

module.exports = { authMiddleware, requireRole, optionalAuth, SECRET }
