'use strict'
const router = require('express').Router()
const { diffObjects }      = require('../shared/diff')
const { classifySeverity } = require('../shared/severity')
const { getResourceConfig } = require('../services/azureResourceService')
const { getBaseline, saveDriftRecord } = require('../services/blobService')
const { broadcastDriftEvent } = require('../services/signalrService')
const { sendDriftAlert }   = require('../services/alertService')
const { explainDrift, reclassifySeverity } = require('../services/aiService')

const _sessions = {}


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
    sendDriftAlert(record).catch(() => {})
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
router.post('/monitor/start', (req, res) => {
  console.log('[POST /monitor/start] starts')
  const { subscriptionId, resourceGroupId, resourceId, intervalMs = 30000 } = req.body
  if (!subscriptionId || !resourceGroupId) return res.status(400).json({ error: 'subscriptionId and resourceGroupId required' })
  const key = `${subscriptionId}:${resourceGroupId}:${resourceId || ''}`
  if (_sessions[key]) clearInterval(_sessions[key])
  _sessions[key] = setInterval(() => runDriftCheck(subscriptionId, resourceGroupId, resourceId || null).catch(() => {}), Math.max(Number(intervalMs), 15000))
  res.json({ monitoring: true, key })
})
// ── POST /api/monitor/start END ──────────────────────────────────────────────

router.post('/monitor/stop', (req, res) => {
  console.log('[POST /monitor/stop] starts')
  const { subscriptionId, resourceGroupId, resourceId } = req.body
  const key = `${subscriptionId}:${resourceGroupId}:${resourceId || ''}`
  if (_sessions[key]) { clearInterval(_sessions[key]); delete _sessions[key] }
  res.json({ monitoring: false, key })
  console.log('[POST /monitor/stop] ends — key:', key)
})
// ── POST /api/monitor/stop END ───────────────────────────────────────────────

module.exports = router