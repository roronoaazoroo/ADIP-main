'use strict'
const router = require('express').Router()
const { diffObjects }      = require('../shared/diff')
const { classifySeverity } = require('../shared/severity')
const { getResourceConfig } = require('../services/azureResourceService')
const { getBaseline, saveDriftRecord } = require('../services/blobService')
const { broadcastDriftEvent } = require('../services/socketService')
const { explainDrift, reclassifySeverity } = require('../services/aiService')

const { TableClient } = require('@azure/data-tables')

// Returns a Table Storage client for monitorSessions — stores active monitoring sessions
function getMonitorSessionsTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'monitorSessions')
}

// Generates a stable Table Storage row key from the session scope
function buildSessionRowKey(subscriptionId, resourceGroupId, resourceId) {
  const compositeKey = `${subscriptionId}:${resourceGroupId}:${resourceId || ''}`
  return Buffer.from(compositeKey).toString('base64url').slice(0, 512)
}


// ── runDriftCheck START ──────────────────────────────────────────────────────
// Full drift check pipeline: fetches live + baseline, diffs, classifies, runs AI, saves record, alerts
async function runDriftCheck(subscriptionId, resourceGroupId, resourceId) {
  console.log('[runDriftCheck] starts — subscriptionId:', subscriptionId, 'rg:', resourceGroupId, 'resourceId:', resourceId)
  const [currentLiveConfig, storedBaseline] = await Promise.all([
    getResourceConfig(subscriptionId, resourceGroupId, resourceId || null),
    getBaseline(subscriptionId, resourceId || resourceGroupId),
  ])

  const detectedChanges = storedBaseline?.resourceState ? diffObjects(storedBaseline.resourceState, currentLiveConfig) : []
  const driftSeverity   = classifySeverity(detectedChanges)
  const driftRecord = {
    subscriptionId, resourceGroupId,
    resourceId:    resourceId || null,
    resourceGroup: resourceGroupId,
    liveState:     currentLiveConfig,
    baselineState: storedBaseline?.resourceState || null,
    differences:   detectedChanges,
    severity:      driftSeverity,
    changeCount:   detectedChanges.length,
    detectedAt:    new Date().toISOString(),
  }

  if (detectedChanges.length > 0) {
    // Run AI explanation and severity re-classification in parallel (non-blocking)
    const [aiExplanationResult, aiSeverityResult] = await Promise.allSettled([
      explainDrift(driftRecord), reclassifySeverity(driftRecord),
    ]).then(results => results.map(result => result.value ?? null))

    if (aiExplanationResult) driftRecord.aiExplanation = aiExplanationResult
    if (aiSeverityResult) {
      driftRecord.aiSeverity  = aiSeverityResult.severity
      driftRecord.aiReasoning = aiSeverityResult.reasoning
      // AI can only escalate severity, never reduce it
      const severityOrder = ['none', 'low', 'medium', 'high', 'critical']
      if (severityOrder.indexOf(aiSeverityResult.severity) > severityOrder.indexOf(driftRecord.severity)) {
        driftRecord.severity = aiSeverityResult.severity
      }
    }
    await saveDriftRecord(driftRecord)
    broadcastDriftEvent(driftRecord)
  }
  console.log('[runDriftCheck] ends — severity:', driftRecord.severity, 'changes:', detectedChanges.length)
  return driftRecord
}
// ── runDriftCheck END ────────────────────────────────────────────────────────

router.post('/compare', async (req, res) => {
  console.log('[POST /compare] starts')
  const { subscriptionId, resourceGroupId, resourceId } = req.body
  if (!subscriptionId || !resourceGroupId) return res.status(400).json({ error: 'subscriptionId and resourceGroupId required' })
  try { res.json(await runDriftCheck(subscriptionId, resourceGroupId, resourceId || null)) }
  catch (err) { res.status(500).json({ error: err.message }) }
})
router.post('/monitor/start', async (req, res) => {
  const { subscriptionId, resourceGroupId, resourceId, intervalMs = 60000 } = req.body
  if (!subscriptionId || !resourceGroupId) return res.status(400).json({ error: 'subscriptionId and resourceGroupId required' })
  const sessionTableRowKey = buildSessionRowKey(subscriptionId, resourceGroupId, resourceId)
  try {
    await getMonitorSessionsTable().upsertEntity({
      partitionKey:    'session',
      rowKey:          sessionTableRowKey,
      subscriptionId,
      resourceGroupId,
      resourceId:      resourceId || '',
      intervalMs:      Math.max(Number(intervalMs), 60000),  // minimum 1 minute
      active:          true,
      startedAt:       new Date().toISOString(),
    }, 'Replace')
    res.json({ monitoring: true, key: sessionTableRowKey })
  } catch (startError) { res.status(500).json({ error: startError.message }) }
})

router.post('/monitor/stop', async (req, res) => {
  const { subscriptionId, resourceGroupId, resourceId } = req.body
  const sessionTableRowKey = buildSessionRowKey(subscriptionId, resourceGroupId, resourceId)
  try {
    await getMonitorSessionsTable().upsertEntity({
      partitionKey: 'session', rowKey: sessionTableRowKey,
      subscriptionId, resourceGroupId, resourceId: resourceId || '',
      active: false,
    }, 'Merge')
    res.json({ monitoring: false, key: sessionTableRowKey })
  } catch (stopError) { res.status(500).json({ error: stopError.message }) }
})

module.exports = router