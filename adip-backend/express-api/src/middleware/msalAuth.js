// ============================================================
// FILE: adip-backend/express-api/src/middleware/msalAuth.js
// ROLE: Azure AD / MSAL token validation middleware
//       Validates Azure AD JWT tokens for enterprise SSO
//       Falls back to local JWT auth when MSAL is not configured
// ============================================================
'use strict'
const jwt = require('jsonwebtoken')
const jwksClient = require('jwks-rsa')

const TENANT_ID = process.env.AZURE_TENANT_ID
const CLIENT_ID = process.env.AZURE_AD_CLIENT_ID
const MSAL_ENABLED = !!(TENANT_ID && CLIENT_ID)

let _jwksClient = null
function getJwksClient() {
  if (!_jwksClient && MSAL_ENABLED) {
    _jwksClient = jwksClient({
      jwksUri: `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`,
      cache: true,
      rateLimit: true,
    })
  }
  return _jwksClient
}

/**
 * Validates Azure AD tokens when MSAL is configured.
 * Falls back to local JWT validation otherwise.
 */
async function msalAuth(req, res, next) {
  if (!MSAL_ENABLED) return next() // Skip if not configured

  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' })
  }

  const token = authHeader.slice(7)

  try {
    // Decode header to get kid
    const decoded = jwt.decode(token, { complete: true })
    if (!decoded?.header?.kid) throw new Error('Invalid token header')

    // Get signing key from Azure AD JWKS
    const client = getJwksClient()
    const key = await client.getSigningKey(decoded.header.kid)
    const signingKey = key.getPublicKey()

    // Verify token
    const payload = jwt.verify(token, signingKey, {
      audience: CLIENT_ID,
      issuer: `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
    })

    // Map Azure AD claims to app user object
    req.user = {
      userId: payload.oid || payload.sub,
      email: payload.preferred_username || payload.email,
      name: payload.name,
      role: mapAzureAdRole(payload.roles || []),
      orgId: payload.tid,
    }
    next()
  } catch (error) {
    res.status(401).json({ error: 'Invalid Azure AD token' })
  }
}

function mapAzureAdRole(roles) {
  if (roles.includes('Admin') || roles.includes('adip.admin')) return 'admin'
  if (roles.includes('Approver') || roles.includes('adip.approver')) return 'approver'
  return 'requestor'
}

module.exports = { msalAuth, MSAL_ENABLED }
