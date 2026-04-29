// ============================================================
// FILE: adip-backend/express-api/src/routes/attribution.js
// ROLE: Change Attribution endpoint
//
// GET /api/attribution?subscriptionId=&days=
//   Aggregates changesIndex + driftIndex by caller identity.
//   Returns per-caller: totalChanges, driftCount, topResourceType, riskLevel
// ============================================================
'use strict'
const router = require('express').Router()
const { getChangesIndexTableClient, getDriftIndexTableClient } = require('../services/blobService')

const RISK_THRESHOLDS = { critical: 5, high: 2, medium: 1 }

// Only count real human/SPN callers — same rule as blobService.isHumanCaller
function isHumanCaller(caller) {
  if (!caller || !caller.trim()) return false
  const c = caller.trim().toLowerCase()
  return c !== 'system' && c !== 'manual-compare' && !c.startsWith('azure ')
}

// Derives risk level from drift count caused by a caller
function riskLevel(driftCount) {
  if (driftCount >= RISK_THRESHOLDS.critical) return 'critical'
  if (driftCount >= RISK_THRESHOLDS.high)     return 'high'
  if (driftCount >= RISK_THRESHOLDS.medium)   return 'medium'
  return 'low'
}

// Extracts resource type from a full ARM resourceId
function resourceType(resourceId) {
  if (!resourceId) return 'Unknown'
  const parts = resourceId.split('/')
  const provIdx = parts.findIndex(p => p.toLowerCase() === 'providers')
  if (provIdx !== -1 && parts[provIdx + 1] && parts[provIdx + 2]) {
    return `${parts[provIdx + 1]}/${parts[provIdx + 2]}`
  }
  return 'Unknown'
}

// GET /api/attribution?subscriptionId=&days=30
router.get('/attribution', async (req, res) => {
  console.log('[GET /attribution] starts')
  const { subscriptionId, days = '30' } = req.query

  if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' })
  if (subscriptionId.includes("'")) return res.status(400).json({ error: 'Invalid subscriptionId' })

  // Use system Timestamp (DateTime typed) for reliable OData date filtering in Table Storage
  const sinceTimestamp = new Date(Date.now() - Number(days) * 86400000).toISOString()
  const tsFilter = (pk) => `PartitionKey eq '${pk}' and Timestamp ge datetime'${sinceTimestamp}'`

  try {
    const callerMap = {}

    for await (const entity of getChangesIndexTableClient().listEntities({ queryOptions: { filter: tsFilter(subscriptionId) } })) {
      const caller = entity.caller?.trim()
      if (!isHumanCaller(caller)) continue
      if (!callerMap[caller]) callerMap[caller] = { caller, totalChanges: 0, driftCount: 0, resourceTypeCounts: {} }
      callerMap[caller].totalChanges++
      const rType = resourceType(entity.resourceId)
      callerMap[caller].resourceTypeCounts[rType] = (callerMap[caller].resourceTypeCounts[rType] || 0) + 1
    }

    for await (const entity of getDriftIndexTableClient().listEntities({ queryOptions: { filter: tsFilter(subscriptionId) } })) {
      const caller = entity.caller?.trim()
      if (!isHumanCaller(caller)) continue
      if (!callerMap[caller]) callerMap[caller] = { caller, totalChanges: 0, driftCount: 0, resourceTypeCounts: {} }
      callerMap[caller].driftCount++
    }

    // ── Build response ────────────────────────────────────────────────────────
    const result = Object.values(callerMap)
      .map(c => ({
        caller:          c.caller,
        totalChanges:    c.totalChanges,
        driftCount:      c.driftCount,
        topResourceType: Object.entries(c.resourceTypeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Unknown',
        riskLevel:       riskLevel(c.driftCount),
      }))
      .sort((a, b) => b.totalChanges - a.totalChanges)

    res.json(result)
    console.log('[GET /attribution] ends — callers:', result.length)
  } catch (err) {
    console.log('[GET /attribution] ends — error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
