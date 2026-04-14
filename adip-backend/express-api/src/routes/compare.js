'use strict'
const router = require('express').Router()
const { diffObjects }      = require('../shared/diff')
const { classifySeverity } = require('../shared/severity')
const { getResourceConfig } = require('../services/azureResourceService')
const { getBaseline, saveDriftRecord } = require('../services/blobService')
const { broadcastDriftEvent } = require('../services/socketService')
const { explainDrift, reclassifySeverity } = require('../services/aiService')

const { TableClient } = require('@azure/data-tables')

function getSessionTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'monitorSessions')
}

function sessionRowKey(subscriptionId, resourceGroupId, resourceId) {
  const key = `${subscriptionId}:${resourceGroupId}:${resourceId || ''}`
  return Buffer.from(key).toString('base64url').slice(0, 512)
}


// ── runDriftCheck START ──────────────────────────────────────────────────────
// Full drift check pipeline: fetches live + baseline, diffs, classifies, runs AI, saves record, alerts
async function runDriftCheck(subscriptionId, resourceGroupId, resourceId) {
  console.log('[runDriftCheck] starts — subscriptionId:', subscriptionId, 'rg:', resourceGroupId, 'resourceId:', resourceId)
  const [liveRaw, baseline] = await Promise.all([
    getResourceConfig(subscriptionId, resourceGroupId, resourceId || null),
    getBaseline(subscriptionId, resourceId || resourceGroupId),
  ])

  const differences = baseline?.resourceState ? diffObjects(baseline.resourceState, liveRaw) : []
  const severity    = classifySeverity(differences)
  const record = {
    subscriptionId, resourceGroupId,
    resourceId: resourceId || null, resourceGroup: resourceGroupId,
    liveState: liveRaw, baselineState: baseline?.resourceState || null,
    differences, severity, changeCount: differences.length,
    detectedAt: new Date().toISOString(),
  }

  if (differences.length > 0) {
    const [aiExplanation, aiSeverity] = await Promise.allSettled([
      explainDrift(record), reclassifySeverity(record),
    ]).then(r => r.map(x => x.value ?? null))

    if (aiExplanation) record.aiExplanation = aiExplanation
    if (aiSeverity) {
      record.aiSeverity = aiSeverity.severity; record.aiReasoning = aiSeverity.reasoning
      const order = ['none','low','medium','high','critical']
      if (order.indexOf(aiSeverity.severity) > order.indexOf(record.severity)) record.severity = aiSeverity.severity
    }
    await saveDriftRecord(record)
    broadcastDriftEvent(record)
  }
  console.log('[runDriftCheck] ends — severity:', record.severity, 'changes:', differences.length)
  return record
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
  const rk = sessionRowKey(subscriptionId, resourceGroupId, resourceId)
  try {
    await getSessionTable().upsertEntity({
      partitionKey:    'session',
      rowKey:          rk,
      subscriptionId,
      resourceGroupId,
      resourceId:      resourceId || '',
      intervalMs:      Math.max(Number(intervalMs), 60000),
      active:          true,
      startedAt:       new Date().toISOString(),
    }, 'Replace')
    res.json({ monitoring: true, key: rk })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

router.post('/monitor/stop', async (req, res) => {
  const { subscriptionId, resourceGroupId, resourceId } = req.body
  const rk = sessionRowKey(subscriptionId, resourceGroupId, resourceId)
  try {
    await getSessionTable().upsertEntity({
      partitionKey: 'session', rowKey: rk,
      subscriptionId, resourceGroupId, resourceId: resourceId || '',
      active: false,
    }, 'Merge')
    res.json({ monitoring: false, key: rk })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

module.exports = router