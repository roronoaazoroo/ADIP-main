const router = require('express').Router()
const { diff } = require('deep-diff')
const { getResourceConfig } = require('../services/azureResourceService')
const { getBaseline, saveDriftRecord } = require('../services/cosmosService')
const { broadcastDriftEvent } = require('../services/signalrService')
const { sendDriftAlert } = require('../services/alertService')
const { explainDrift, reclassifySeverity } = require('../services/aiService')

const VOLATILE = ['etag', 'changedTime', 'createdTime', 'provisioningState', 'lastModifiedAt', 'systemData', '_ts', '_etag']
const CRITICAL_PATHS = ['properties.networkAcls', 'properties.accessPolicies', 'properties.securityRules', 'sku', 'location', 'identity', 'properties.encryption']

// Active monitoring sessions: key → intervalId
const monitoringSessions = {}

function strip(obj) {
  if (Array.isArray(obj)) return obj.map(strip)
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).filter(([k]) => !VOLATILE.includes(k)).map(([k, v]) => [k, strip(v)]))
  }
  return obj
}

function classifySeverity(differences) {
  if (!differences.length) return 'none'
  if (differences.some(d => d.kind === 'D')) return 'critical'
  if (differences.some(d => CRITICAL_PATHS.some(p => d.path?.join('.').startsWith(p)))) return 'high'
  if (differences.length > 5) return 'medium'
  return 'low'
}

async function runDriftCheck(subscriptionId, resourceGroupId, resourceId) {
  const [liveRaw, baseline] = await Promise.all([
    getResourceConfig(subscriptionId, resourceGroupId, resourceId || null),
    getBaseline(subscriptionId, resourceId || resourceGroupId),
  ])
  const live = strip(liveRaw)
  const base = baseline ? strip(baseline.resourceState) : null
  const differences = base ? (diff(base, live) || []) : []
  const severity = classifySeverity(differences)
  const record = {
    subscriptionId, resourceGroupId,
    resourceId: resourceId || null,
    resourceGroup: resourceGroupId,
    liveState: live, baselineState: base,
    differences, severity,
    changeCount: differences.length,
    detectedAt: new Date().toISOString(),
  }
  if (differences.length > 0) {
    // Run AI explanation and re-classification in parallel (non-blocking)
    const [aiExplanation, aiSeverity] = await Promise.all([
      explainDrift(record),
      reclassifySeverity(record),
    ]).catch(() => [null, null])

    if (aiExplanation) record.aiExplanation = aiExplanation
    if (aiSeverity) {
      record.aiSeverity  = aiSeverity.severity
      record.aiReasoning = aiSeverity.reasoning
      // Use AI severity if it's more severe than rule-based
      const order = ['none','low','medium','high','critical']
      if (order.indexOf(aiSeverity.severity) > order.indexOf(record.severity)) {
        record.severity = aiSeverity.severity
      }
    }

    await saveDriftRecord(record)
    broadcastDriftEvent(record)
    sendDriftAlert(record).catch(err => console.error('[Alert]', err.message))
  }
  return record
}

// Manual one-shot compare
router.post('/compare', async (req, res) => {
  const { subscriptionId, resourceGroupId, resourceId } = req.body
  if (!subscriptionId || !resourceGroupId) return res.status(400).json({ error: 'subscriptionId and resourceGroupId required' })
  try {
    const record = await runDriftCheck(subscriptionId, resourceGroupId, resourceId || null)
    res.json(record)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Start real-time monitoring (polls every 30s, pushes via Socket.IO)
router.post('/monitor/start', (req, res) => {
  const { subscriptionId, resourceGroupId, resourceId, intervalMs = 30000 } = req.body
  if (!subscriptionId || !resourceGroupId) return res.status(400).json({ error: 'subscriptionId and resourceGroupId required' })

  const key = `${subscriptionId}:${resourceGroupId}:${resourceId || ''}`
  if (monitoringSessions[key]) clearInterval(monitoringSessions[key])

  monitoringSessions[key] = setInterval(async () => {
    try { await runDriftCheck(subscriptionId, resourceGroupId, resourceId || null) } catch (_) {}
  }, Math.max(intervalMs, 15000))

  res.json({ monitoring: true, key, intervalMs })
})

// Stop real-time monitoring
router.post('/monitor/stop', (req, res) => {
  const { subscriptionId, resourceGroupId, resourceId } = req.body
  const key = `${subscriptionId}:${resourceGroupId}:${resourceId || ''}`
  if (monitoringSessions[key]) {
    clearInterval(monitoringSessions[key])
    delete monitoringSessions[key]
  }
  res.json({ monitoring: false, key })
})

module.exports = router
