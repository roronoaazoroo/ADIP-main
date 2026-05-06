// FILE: adip-backend/express-api/src/routes/driftImpact.js
// ROLE: Aggregates drift data for the Impact Analysis page

// GET /api/drift-impact?subscriptionId=&days=30
//   Returns:
//     - dailyVolume[]     — drift count per day for the period
//     - severityTotals    — { critical, high, medium, low }
//     - topResources[]    — most frequently drifted resources
//     - resourceGroupRisk[] — drift count + severity per RG
//     - remediationRate   — % of drift events that were remediated

// Uses driftIndex Table (Timestamp filter) — no blob reads

'use strict'
const router = require('express').Router()
const { getDriftIndexTableClient, readBlob } = require('../services/blobService')

const CACHE_TTL_MS = 5 * 60 * 1000
const _cache = new Map()

// Derives a risk level from severity counts
function riskLevel(critical, high, medium) {
  if (critical > 0) return 'critical'
  if (high > 0)     return 'high'
  if (medium > 0)   return 'medium'
  return 'low'
}

router.get('/drift-impact', async (req, res) => {
  console.log('[GET /drift-impact] starts')
  const { subscriptionId, days = '30' } = req.query
  if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' })

  const cacheKey = `${subscriptionId}|${days}`
  const cached   = _cache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    console.log('[GET /drift-impact] ends — cache hit')
    return res.json(cached.data)
  }

  const sinceISO = new Date(Date.now() - Number(days) * 86400000).toISOString()
  const filter   = `PartitionKey eq '${subscriptionId}' and Timestamp ge datetime'${sinceISO}'`

  try {
    // Accumulators
    const dailyMap    = {}   // 'YYYY-MM-DD' → count
    const severityTotals = { critical: 0, high: 0, medium: 0, low: 0 }
    const resourceMap = {}   // resourceId → { name, driftCount, maxSeverity, resourceGroup }
    const rgMap       = {}   // resourceGroup → { driftCount, critical, high, medium, low }

    for await (const entity of getDriftIndexTableClient().listEntities({ queryOptions: { filter } })) {
      const day      = (entity.detectedAt || entity.Timestamp || '').slice(0, 10)
      const severity = (entity.severity || 'low').toLowerCase()
      const resId    = entity.resourceId || 'unknown'
      const rg       = entity.resourceGroup || 'unknown'

      // Daily volume
      if (day) dailyMap[day] = (dailyMap[day] || 0) + 1

      // Severity totals
      if (severityTotals[severity] !== undefined) severityTotals[severity]++

      // Per-resource
      if (!resourceMap[resId]) {
        resourceMap[resId] = { resourceId: resId, name: resId.split('/').pop(), driftCount: 0, maxSeverity: 'low', resourceGroup: rg }
      }
      resourceMap[resId].driftCount++
      const order = ['low', 'medium', 'high', 'critical']
      if (order.indexOf(severity) > order.indexOf(resourceMap[resId].maxSeverity)) {
        resourceMap[resId].maxSeverity = severity
      }

      // Per-RG
      if (!rgMap[rg]) rgMap[rg] = { resourceGroup: rg, driftCount: 0, critical: 0, high: 0, medium: 0, low: 0 }
      rgMap[rg].driftCount++
      if (rgMap[rg][severity] !== undefined) rgMap[rg][severity]++
    }

    // Build daily series — fill gaps with 0
    const dailyVolume = []
    for (let i = Number(days) - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000)
      const key = d.toISOString().slice(0, 10)
      dailyVolume.push({ date: key, label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), count: dailyMap[key] || 0 })
    }

    const topResources = Object.values(resourceMap)
      .sort((a, b) => b.driftCount - a.driftCount)
      .slice(0, 8)

    const resourceGroupRisk = Object.values(rgMap)
      .map(rg => ({ ...rg, riskLevel: riskLevel(rg.critical, rg.high, rg.medium) }))
      .sort((a, b) => b.driftCount - a.driftCount)

    const totalDrifts = Object.values(severityTotals).reduce((s, v) => s + v, 0)

    const result = { dailyVolume, severityTotals, topResources, resourceGroupRisk, totalDrifts, period: Number(days) }
    _cache.set(cacheKey, { data: result, expiresAt: Date.now() + CACHE_TTL_MS })
    res.json(result)
    console.log('[GET /drift-impact] ends — totalDrifts:', totalDrifts)
  } catch (err) {
    console.log('[GET /drift-impact] error:', err.message)
    res.status(500).json({ error: err.message })
  }
})


// GET /api/drift-impact/resource?subscriptionId=&resourceId=&limit=10
// Returns full drift event details (with human-readable diff) for a specific resource
router.get('/drift-impact/resource', async (req, res) => {
  console.log('[GET /drift-impact/resource] starts')
  const { subscriptionId, resourceId, limit = '10' } = req.query
  if (!subscriptionId || !resourceId) return res.status(400).json({ error: 'subscriptionId and resourceId required' })

  try {
    const filter = `PartitionKey eq '${subscriptionId}' and resourceId eq '${resourceId}'`
    const entities = []
    for await (const entity of getDriftIndexTableClient().listEntities({ queryOptions: { filter } })) {
      entities.push(entity)
    }
    // Sort newest first, take limit
    entities.sort((a, b) => new Date(b.detectedAt || 0) - new Date(a.detectedAt || 0))
    const top = entities.slice(0, Number(limit))

    // Fetch blob details for each index entry
    const events = await Promise.all(top.map(async entity => {
      try {
        const blob = entity.blobKey ? await readBlob('drift-records', entity.blobKey) : null
        const differences = (blob?.differences || blob?.changes || []).map(d => ({
          path:     d.path || '',
          type:     d.type || 'modified',
          sentence: d.sentence || humanReadable(d),
        }))
        return {
          detectedAt:  entity.detectedAt,
          severity:    entity.severity,
          caller:      entity.caller || blob?.caller || 'Unknown',
          changeCount: entity.changeCount || differences.length,
          differences,
        }
      } catch {
        return {
          detectedAt:  entity.detectedAt,
          severity:    entity.severity,
          caller:      entity.caller || 'Unknown',
          changeCount: entity.changeCount || 0,
          differences: [],
        }
      }
    }))

    res.json(events)
    console.log('[GET /drift-impact/resource] ends — events:', events.length)
  } catch (err) {
    console.log('[GET /drift-impact/resource] error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// Converts a raw diff object to a human-readable sentence when sentence field is absent
function humanReadable(d) {
  const field = (d.path || '').split(' → ').pop() || d.path
  if (d.type === 'added')    return `Added "${field}": ${JSON.stringify(d.newValue)}`
  if (d.type === 'removed')  return `Removed "${field}" (was ${JSON.stringify(d.oldValue)})`
  if (d.type === 'modified') return `Changed "${field}" from ${JSON.stringify(d.oldValue)} to ${JSON.stringify(d.newValue)}`
  return `${d.type} on "${field}"`
}

module.exports = router
