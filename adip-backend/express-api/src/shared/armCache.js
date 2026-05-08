// ============================================================
// FILE: shared/armCache.js
// ROLE: Shared Azure SDK clients + 30s ARM response cache
// Reduces ARM calls by >90% for polling scenarios
// ============================================================
'use strict'
const { ResourceManagementClient } = require('@azure/arm-resources')
const { DefaultAzureCredential } = require('@azure/identity')
const { breakers } = require('./circuitBreaker')

// Singleton credential + client cache
const credential = new DefaultAzureCredential()
const _clients = new Map()

function getArmClient(subscriptionId) {
  if (!_clients.has(subscriptionId)) {
    _clients.set(subscriptionId, new ResourceManagementClient(credential, subscriptionId))
  }
  return _clients.get(subscriptionId)
}

// ARM response cache (30s TTL)
const _cache = new Map()
const CACHE_TTL = 30_000

function cacheKey(sub, rg, resourceId) {
  return `${sub}|${rg}|${resourceId || ''}`
}

function getCached(sub, rg, resourceId) {
  const key = cacheKey(sub, rg, resourceId)
  const entry = _cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > CACHE_TTL) { _cache.delete(key); return null }
  return entry.data
}

function setCache(sub, rg, resourceId, data) {
  const key = cacheKey(sub, rg, resourceId)
  _cache.set(key, { data, ts: Date.now() })
  // Prune old entries every 100 sets
  if (_cache.size > 200) {
    const now = Date.now()
    for (const [k, v] of _cache) { if (now - v.ts > CACHE_TTL) _cache.delete(k) }
  }
}

function invalidateCache(sub, rg, resourceId) {
  _cache.delete(cacheKey(sub, rg, resourceId))
}

module.exports = { credential, getArmClient, getCached, setCache, invalidateCache }

/**
 * Execute an ARM operation with circuit breaker protection.
 */
async function armCall(fn) {
  return breakers.arm.call(fn)
}

module.exports.armCall = armCall
