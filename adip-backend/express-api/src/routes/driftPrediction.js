'use strict'
const router = require('express').Router()
const { getChangesIndexTableClient, getDriftIndexTableClient } = require('../services/blobService')
const { buildFeatureVector } = require('../services/featureBuilder')
const { predictDriftRisk } = require('../services/mlPredictionService')

const CACHE_TTL = 5 * 60 * 1000
const _cache = new Map()

const WEIGHTS = {
  changeFrequency: parseFloat(process.env.PRED_WEIGHT_FREQUENCY || '0.25'),
  driftRatio:      parseFloat(process.env.PRED_WEIGHT_DRIFT_RATIO || '0.30'),
  recency:         parseFloat(process.env.PRED_WEIGHT_RECENCY || '0.15'),
  uniqueCallers:   parseFloat(process.env.PRED_WEIGHT_CALLERS || '0.10'),
  securityFields:  parseFloat(process.env.PRED_WEIGHT_SECURITY || '0.10'),
  offHours:        parseFloat(process.env.PRED_WEIGHT_OFFHOURS || '0.10'),
}

function isOffHours(timestamp) {
  const h = new Date(timestamp).getUTCHours()
  return h < 9 || h > 17
}

function isSecurityField(eventType) {
  const s = (eventType || '').toLowerCase()
  return /network|security|encryption|tls|https|access|firewall|key/.test(s)
}

// GET /api/prediction/rg-risk?subscriptionId=&resourceGroup=
router.get('/prediction/rg-risk', async (req, res) => {
  const { subscriptionId, resourceGroup } = req.query
  if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' })

  const cacheKey = `${subscriptionId}|${resourceGroup}`
  const cached = _cache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return res.json(cached.data)

  try {
    const since = new Date(Date.now() - 30 * 86400000).toISOString()
    const changesTable = getChangesIndexTableClient()
    const driftTable = getDriftIndexTableClient()

    // Gather change data per resource (lowercase key for dedup)
    const resourceMap = {}
    const filter = `PartitionKey eq '${subscriptionId}' and Timestamp ge datetime'${since}'`

    for await (const entity of changesTable.listEntities({ queryOptions: { filter } })) {
      if (resourceGroup && entity.resourceGroup?.toLowerCase() !== resourceGroup.toLowerCase()) continue
      const rid = (entity.resourceId || '').toLowerCase()
      if (!rid) continue
      if (!resourceMap[rid]) resourceMap[rid] = { originalId: entity.resourceId, changes: [], drifts: 0, callers: new Set(), latestEvent: '' }
      resourceMap[rid].changes.push({ detectedAt: entity.detectedAt, caller: entity.caller, eventType: entity.eventType || '', changeType: entity.changeType || '' })
      if (entity.caller) resourceMap[rid].callers.add(entity.caller)
      // Track latest event to determine if resource is deleted
      if (!resourceMap[rid].latestEvent || entity.detectedAt > resourceMap[rid].latestEvent) {
        resourceMap[rid].latestEvent = entity.detectedAt
        resourceMap[rid].latestChangeType = entity.changeType || ''
      }
    }

    // Gather drift counts per resource
    for await (const entity of driftTable.listEntities({ queryOptions: { filter } })) {
      if (resourceGroup && entity.resourceGroup?.toLowerCase() !== resourceGroup.toLowerCase()) continue
      const rid = (entity.resourceId || '').toLowerCase()
      if (resourceMap[rid]) resourceMap[rid].drifts++
    }

    // Filter out noise resources (policy assignments, action groups, RG itself, system resources)
    const NOISE_TYPES = ['microsoft.authorization/policyassignments', 'microsoft.authorization/roleassignments', 'microsoft.insights/actiongroups', 'microsoft.insights/metricalerts', 'microsoft.insights/scheduledqueryrules', 'microsoft.insights/diagnosticsettings', 'microsoft.alertsmanagement/smartdetectoralertrules']
    for (const [rid, data] of Object.entries(resourceMap)) {
      const rtype = (data.originalId || rid).split('/').slice(6, 8).join('/').toLowerCase()
      const rname = (data.originalId || rid).split('/').pop() || ''
      if (NOISE_TYPES.includes(rtype) || !rtype || rname.length > 50 || /^[a-f0-9-]{30,}/.test(rname)) delete resourceMap[rid]
    }

    // Build feature vectors + call ML endpoint
    const resourceKeys = []
    let mlPredictions = null
    const validEntries = Object.entries(resourceMap).filter(([rid, data]) => data && data.latestChangeType !== 'deleted' && data.changes.length >= 2)
    const featureVectors = validEntries.map(([rid, data]) => {
      resourceKeys.push(rid)
      return buildFeatureVector({
        resourceId: data.originalId || rid,
        changes: data.changes,
        drifts: [],
        baselineDate: null,
        callerDriftCounts: {},
        rgDriftCount: 0,
        rgResourceCount: validEntries.length,
      })
    })
    if (featureVectors.length > 0) {
      try { mlPredictions = await predictDriftRisk(featureVectors) } catch { /* fallback below */ }
    }

    // Compute scores
    const results = []
    for (const [rid, data] of Object.entries(resourceMap)) {
      if (!data) continue
      if (data.latestChangeType === 'deleted') continue // skip if latest event is deletion
      const totalChanges = data.changes.length
      if (totalChanges < 2) continue // need at least 2 changes for meaningful prediction

      const daySpan = Math.max(1, 30)
      const changeFrequency = Math.min(totalChanges / daySpan, 5) / 5 // normalize 0-1
      const driftRatio = totalChanges > 0 ? Math.min(data.drifts / totalChanges, 1) : 0
      const lastChange = data.changes.sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt))[0]
      const hoursSinceLast = (Date.now() - new Date(lastChange?.detectedAt || 0)) / 3600000
      const recency = Math.max(0, 1 - (hoursSinceLast / 720)) // 0-1, higher = more recent
      const uniqueCallers = Math.min(data.callers.size / 5, 1) // normalize 0-1
      const securityFields = data.changes.filter(c => isSecurityField(c.eventType)).length / totalChanges
      const offHours = data.changes.filter(c => isOffHours(c.detectedAt)).length / totalChanges

      const rawScore = (
        changeFrequency * WEIGHTS.changeFrequency +
        driftRatio * WEIGHTS.driftRatio +
        recency * WEIGHTS.recency +
        uniqueCallers * WEIGHTS.uniqueCallers +
        securityFields * WEIGHTS.securityFields +
        offHours * WEIGHTS.offHours
      )
      let riskScore = Math.round(Math.min(rawScore * 100 / 0.6, 100)) // normalize so max realistic = 100

      const factors = []
      if (changeFrequency > 0.4) factors.push(`${totalChanges} changes in 30 days`)
      if (driftRatio > 0.3) factors.push(`${Math.round(driftRatio * 100)}% of changes caused drift`)
      if (uniqueCallers > 0.4) factors.push(`${data.callers.size} different callers`)
      if (securityFields > 0.3) factors.push('security fields frequently modified')
      if (offHours > 0.3) factors.push('frequent off-hours changes')
      if (recency > 0.8) factors.push('changed very recently')
      if (!factors.length) factors.push('low activity')

      // Use ML prediction if available, otherwise use weighted score
      const keyIdx = resourceKeys.indexOf(rid)
      if (mlPredictions && keyIdx >= 0 && mlPredictions[keyIdx] !== undefined) {
        riskScore = Math.round(mlPredictions[keyIdx] * 100)
      }

      results.push({
        resourceId: data.originalId || rid,
        resourceName: (data.originalId || rid).split('/').pop(),
        resourceType: (data.originalId || rid).split('/').slice(6, 8).join('/'),
        riskScore,
        factors,
        totalChanges,
        driftCount: data.drifts,
      })
    }

    results.sort((a, b) => b.riskScore - a.riskScore)

    // ML model replaces GPT-4o adjustment
    results.sort((a, b) => b.riskScore - a.riskScore)

    _cache.set(cacheKey, { data: results, expiresAt: Date.now() + CACHE_TTL })
    res.json(results)
  } catch (err) { res.status(500).json({ error: err.message }) }
})

module.exports = router
