// ============================================================
// FILE: adip-backend/express-api/src/middleware/authMiddleware.js
// ROLE: JWT verification middleware — attaches req.user to protected routes
// ============================================================
'use strict'
const jwt = require('jsonwebtoken')
const JWT_SECRET = process.env.JWT_SECRET || 'adip-dev-secret-change-in-production'

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' })
  }
  try {
    req.user = jwt.verify(authHeader.slice(7), JWT_SECRET)
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

module.exports = { authMiddleware, requireRole }
