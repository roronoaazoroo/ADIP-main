'use strict'
const router_drift = require('express').Router()
const { getDriftHistory: getDriftRecordsForRoute, getTotalChangesCount, getRecentChanges, getChangesIndexTableClient } = require('../services/blobService')

// Table clients imported from blobService — infrastructure stays in the service layer

// ── GET /api/drift-events ─────────────────────────────────────────────────────
router_drift.get('/drift-events', async (req, res) => {
  const { subscriptionId, resourceGroup, severity, since, caller, limit = 50 } = req.query
  if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' })
  try {
    const driftRecords          = await getDriftRecordsForRoute({ subscriptionId, resourceGroup, severity, startDate: since, limit })
    const callerFilteredRecords = caller ? driftRecords.filter(record => record.caller === caller) : driftRecords
    res.json(callerFilteredRecords)
  } catch (fetchError) { res.status(500).json({ error: fetchError.message }) }
})

// ── GET /api/changes/recent ───────────────────────────────────────────────────
// Returns all changes from all-changes blob in last 24h (or custom window)
// Supports filters: subscriptionId, resourceGroup, caller, changeType, limit
router_drift.get('/changes/recent', async (req, res) => {
  const { subscriptionId, resourceGroup, caller, changeType, hours = 24, limit = 1000 } = req.query
  if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' })
  try {
    const sinceTimestamp      = new Date(Date.now() - Number(hours) * 3600 * 1000).toISOString()
    const recentChangeRecords = await getRecentChanges({ subscriptionId, resourceGroup, caller, changeType, since: sinceTimestamp, limit: Number(limit) || 10000 })
    res.json(recentChangeRecords)
  } catch (fetchError) { res.status(500).json({ error: fetchError.message }) }
})

// ── GET /api/changes/count ────────────────────────────────────────────────────
// Returns total permanent change count (all time) from changesIndex Table
router_drift.get('/changes/count', async (req, res) => {
  const { subscriptionId } = req.query
  if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' })
  try {
    const totalChangeCount = await getTotalChangesCount(subscriptionId)
    res.json({ total: totalChangeCount })
  } catch (fetchError) { res.status(500).json({ error: fetchError.message }) }
})

// ── GET /api/stats/today ──────────────────────────────────────────────────────
router_drift.get('/stats/today', async (req, res) => {
  const { subscriptionId } = req.query
  if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' })

  // Rolling last 24 hours — not midnight-based
  const sinceISO = new Date(Date.now() - 86400000).toISOString()

  try {
    const tc = getChangesIndexTableClient()
    const filter = `PartitionKey eq '${subscriptionId}' and Timestamp ge datetime'${sinceISO}'`

    const uniqueResourceIds    = new Set()
    const uniqueResourceGroups = new Set()
    const uniqueCallerNames    = new Set()
    let totalChangesToday = 0

    for await (const changeEntity of tc.listEntities({ queryOptions: { filter } })) {
      totalChangesToday++
      if (changeEntity.resourceId)    uniqueResourceIds.add(changeEntity.resourceId)
      if (changeEntity.resourceGroup) uniqueResourceGroups.add(changeEntity.resourceGroup)
      if (changeEntity.caller)        uniqueCallerNames.add(changeEntity.caller)
    }

    res.json({
      totalChanges:  totalChangesToday,
      totalDrifted:  uniqueResourceIds.size,
      totalRGs:      uniqueResourceGroups.size,
      uniqueCallers: [...uniqueCallerNames],
      since:         sinceISO,
    })
  } catch (statsError) { res.status(500).json({ error: statsError.message }) }
})

// ── GET /api/stats/chart ──────────────────────────────────────────────────────
// Returns bucketed change counts from changesIndex for bar chart
// mode=24h  → 24 hourly buckets (last 24 hours)
// mode=7d   → 7 daily buckets  (last 7 days)
// mode=30d  → 30 daily buckets (last 30 days)
router_drift.get('/stats/chart', async (req, res) => {
  const { subscriptionId, mode = '24h' } = req.query
  if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' })
  if (!['24h', '7d', '30d'].includes(mode)) return res.status(400).json({ error: 'mode must be 24h, 7d, or 30d' })

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
    const tc = getChangesIndexTableClient()
    const filter = `PartitionKey eq '${subscriptionId}' and detectedAt ge '${since}'`
    for await (const changeEntity of tc.listEntities({ queryOptions: { filter, select: ['detectedAt'] } })) {
      const eventDate = new Date(changeEntity.detectedAt)
      // Build the bucket key matching the format used when creating buckets above
      const bucketKey = mode === '24h'
        ? `${eventDate.toISOString().slice(0, 10)}T${String(eventDate.getHours()).padStart(2, '0')}`
        : eventDate.toISOString().slice(0, 10)
      const matchingBucket = buckets.find(bucket => bucket.key === bucketKey)
      if (matchingBucket) matchingBucket.count++
    }
    res.json({ mode, buckets })
  } catch (chartError) { res.status(500).json({ error: chartError.message }) }
})

module.exports = router_drift
