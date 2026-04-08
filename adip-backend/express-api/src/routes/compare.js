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

async function runDriftCheck(subscriptionId, resourceGroupId, resourceId) {
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
  return record
}

router.post('/compare', async (req, res) => {
  const { subscriptionId, resourceGroupId, resourceId } = req.body
  if (!subscriptionId || !resourceGroupId) return res.status(400).json({ error: 'subscriptionId and resourceGroupId required' })
  try { res.json(await runDriftCheck(subscriptionId, resourceGroupId, resourceId || null)) }
  catch (err) { res.status(500).json({ error: err.message }) }
})
router.post('/monitor/start', (req, res) => {
  const { subscriptionId, resourceGroupId, resourceId, intervalMs = 30000 } = req.body
  if (!subscriptionId || !resourceGroupId) return res.status(400).json({ error: 'subscriptionId and resourceGroupId required' })
  const key = `${subscriptionId}:${resourceGroupId}:${resourceId || ''}`
  if (_sessions[key]) clearInterval(_sessions[key])
  _sessions[key] = setInterval(() => runDriftCheck(subscriptionId, resourceGroupId, resourceId || null).catch(() => {}), Math.max(Number(intervalMs), 15000))
  res.json({ monitoring: true, key })
})

router.post('/monitor/stop', (req, res) => {
  const { subscriptionId, resourceGroupId, resourceId } = req.body
  const key = `${subscriptionId}:${resourceGroupId}:${resourceId || ''}`
  if (_sessions[key]) { clearInterval(_sessions[key]); delete _sessions[key] }
  res.json({ monitoring: false, key })
})

module.exports = router
