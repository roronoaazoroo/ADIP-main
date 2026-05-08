// ============================================================
// FILE: adip-backend/express-api/src/shared/idempotency.js
// ROLE: Idempotency key management — prevents double execution
//       of remediations, deployments, and approvals
// ============================================================
'use strict'
const { TableClient } = require('@azure/data-tables')

let _table = null
function getTable() {
  if (!_table) _table = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'idempotencyKeys')
  return _table
}

/**
 * Check if an operation has already been executed.
 * @param {string} key - Unique idempotency key (e.g., ticketId, deploymentId)
 * @param {number} ttlMs - How long to remember (default 24h)
 * @returns {boolean} true if already executed (duplicate)
 */
async function isDuplicate(key, ttlMs = 24 * 60 * 60 * 1000) {
  try {
    const entity = await getTable().getEntity('idem', key)
    const age = Date.now() - new Date(entity.timestamp || entity.createdAt).getTime()
    return age < ttlMs
  } catch {
    return false
  }
}

/**
 * Mark an operation as executed.
 */
async function markExecuted(key, metadata = {}) {
  try {
    await getTable().upsertEntity({
      partitionKey: 'idem',
      rowKey: key,
      createdAt: new Date().toISOString(),
      ...metadata,
    }, 'Replace')
  } catch { /* non-fatal */ }
}

/**
 * Express middleware — checks X-Idempotency-Key header
 */
function idempotencyMiddleware(req, res, next) {
  const key = req.headers['x-idempotency-key']
  if (!key) return next()

  isDuplicate(key).then(dup => {
    if (dup) return res.status(409).json({ error: 'Operation already executed', idempotencyKey: key })
    req.idempotencyKey = key
    next()
  }).catch(() => next())
}

module.exports = { isDuplicate, markExecuted, idempotencyMiddleware }
