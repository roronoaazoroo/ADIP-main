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
    const tc = getDriftIndexTable()
    const filter = `PartitionKey eq '${subscriptionId}' and detectedAt ge '${sinceISO}'`

    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 }
    const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, label: `${String(h).padStart(2,'0')}:00`, count: 0 }))
    const uniqueResources = new Set()
    const uniqueRGs = new Set()
    const uniqueCallers = new Set()
    let totalChanges = 0

    for await (const entity of tc.listEntities({ queryOptions: { filter } })) {
      totalChanges++
      if (entity.severity && bySeverity[entity.severity] !== undefined) bySeverity[entity.severity]++
      if (entity.resourceId) uniqueResources.add(entity.resourceId)
      if (entity.resourceGroup) uniqueRGs.add(entity.resourceGroup)
      if (entity.caller) uniqueCallers.add(entity.caller)
      const h = new Date(entity.detectedAt).getHours()
      if (byHour[h]) byHour[h].count++
    }

    // Also get all-time total from changesIndex
    const allTimeTotal = await getTotalChangesCount(subscriptionId).catch(() => 0)

    res.json({
      totalChanges,
      totalDrifted:  uniqueResources.size,
      totalRGs:      uniqueRGs.size,
      bySeverity,
      byHour,
      uniqueCallers: [...uniqueCallers],
      since:         sinceISO,
      allTimeTotal,
    })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

module.exports = router_drift
