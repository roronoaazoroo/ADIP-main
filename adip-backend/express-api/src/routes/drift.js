'use strict'
const router_drift = require('express').Router()
const { getDriftHistory: getDriftRecordsForRoute, getTotalChangesCount, getRecentChanges } = require('../services/blobService')
const { TableClient } = require('@azure/data-tables')

function getDriftIndexTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'driftIndex')
}

function getChangesIndexTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'changesIndex')
}

// ── GET /api/drift-events ─────────────────────────────────────────────────────
router_drift.get('/drift-events', async (req, res) => {
  const { subscriptionId, resourceGroup, severity, since, caller, limit = 50 } = req.query
  if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' })
  try {
    const records = await getDriftRecordsForRoute({ subscriptionId, resourceGroup, severity, startDate: since, limit })
    const filtered = caller ? records.filter(r => r.caller === caller) : records
    res.json(filtered)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── GET /api/changes/recent ───────────────────────────────────────────────────
// Returns all changes from all-changes blob in last 24h (or custom window)
// Supports filters: subscriptionId, resourceGroup, caller, changeType, limit
router_drift.get('/changes/recent', async (req, res) => {
  const { subscriptionId, resourceGroup, caller, changeType, hours = 24, limit = 200 } = req.query
  if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' })
  try {
    const since = new Date(Date.now() - Number(hours) * 3600 * 1000).toISOString()
    const records = await getRecentChanges({ subscriptionId, resourceGroup, caller, changeType, since, limit: Number(limit) })
    res.json(records)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── GET /api/changes/count ────────────────────────────────────────────────────
// Returns total permanent change count (all time) from changesIndex Table
router_drift.get('/changes/count', async (req, res) => {
  const { subscriptionId } = req.query
  if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' })
  try {
    const total = await getTotalChangesCount(subscriptionId)
    res.json({ total })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── GET /api/stats/today ──────────────────────────────────────────────────────
router_drift.get('/stats/today', async (req, res) => {
  const { subscriptionId } = req.query
  if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' })

  const since = new Date()
  since.setHours(0, 0, 0, 0)
  const sinceISO = since.toISOString()

  try {
    // Query changesIndex (all ARM events today) for accurate counts
    const tc = getChangesIndexTable()
    const filter = `PartitionKey eq '${subscriptionId}' and detectedAt ge '${sinceISO}'`

    const uniqueResources = new Set()
    const uniqueRGs = new Set()
    const uniqueCallers = new Set()
    let totalChanges = 0

    for await (const entity of tc.listEntities({ queryOptions: { filter } })) {
      totalChanges++
      if (entity.resourceId)    uniqueResources.add(entity.resourceId)
      if (entity.resourceGroup) uniqueRGs.add(entity.resourceGroup)
      if (entity.caller)        uniqueCallers.add(entity.caller)
    }

    const allTimeTotal = await getTotalChangesCount(subscriptionId).catch(() => 0)

    res.json({
      totalChanges,
      totalDrifted:  uniqueResources.size,   // unique resources with changes today
      totalRGs:      uniqueRGs.size,
      uniqueCallers: [...uniqueCallers],
      since:         sinceISO,
      allTimeTotal,
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

// ── GET /api/stats/chart ──────────────────────────────────────────────────────
// Returns bucketed change counts from changesIndex for bar chart
// mode=24h  → 24 hourly buckets (last 24 hours)
// mode=7d   → 7 daily buckets  (last 7 days)
// mode=30d  → 30 daily buckets (last 30 days)
router_drift.get('/stats/chart', async (req, res) => {
  const { subscriptionId, mode = '24h' } = req.query
  if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' })

  const now = Date.now()
  let since, buckets

  if (mode === '7d') {
    since = new Date(now - 7 * 86400000).toISOString()
    buckets = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(now - (6 - i) * 86400000)
      return { label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), count: 0, key: d.toISOString().slice(0, 10) }
    })
  } else if (mode === '30d') {
    since = new Date(now - 30 * 86400000).toISOString()
    buckets = Array.from({ length: 30 }, (_, i) => {
      const d = new Date(now - (29 - i) * 86400000)
      return { label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), count: 0, key: d.toISOString().slice(0, 10) }
    })
  } else {
    // 24h — hourly buckets
    since = new Date(now - 24 * 3600000).toISOString()
    buckets = Array.from({ length: 24 }, (_, i) => {
      const h = new Date(now - (23 - i) * 3600000)
      return { label: `${String(h.getHours()).padStart(2, '0')}:00`, count: 0, key: `${h.toISOString().slice(0, 10)}T${String(h.getHours()).padStart(2, '0')}` }
    })
  }

  try {
    const tc = getChangesIndexTable()
    const filter = `PartitionKey eq '${subscriptionId}' and detectedAt ge '${since}'`
    for await (const entity of tc.listEntities({ queryOptions: { filter, select: ['detectedAt'] } })) {
      const d = new Date(entity.detectedAt)
      let key
      if (mode === '24h') {
        key = `${d.toISOString().slice(0, 10)}T${String(d.getHours()).padStart(2, '0')}`
      } else {
        key = d.toISOString().slice(0, 10)
      }
      const bucket = buckets.find(b => b.key === key)
      if (bucket) bucket.count++
    }
    res.json({ mode, buckets })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

module.exports = router_drift
