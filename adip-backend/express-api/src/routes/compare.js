'use strict'
const router = require('express').Router()
const { diffObjects }      = require('../shared/diff')
const { classifySeverity } = require('../shared/severity')
const { getResourceConfig } = require('../services/azureResourceService')
const { getBaseline, saveDriftRecord } = require('../services/blobService')
const { broadcastDriftEvent } = require('../services/socketService')
const { explainDrift, reclassifySeverity } = require('../services/aiService')
const { TableClient } = require('@azure/data-tables')
const { mapDiffToControls } = require('../shared/complianceMap')

// Loads active suppression rules for a subscription from Table Storage
async function loadSuppressionRules(subscriptionId) {
  try {
    const tc = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'suppressionRules')
    const rules = []
    for await (const entity of tc.listEntities({ queryOptions: { filter: `PartitionKey eq '${subscriptionId}'` } })) {
      rules.push({
        fieldPath:       entity.fieldPath,
        resourceGroupId: entity.resourceGroupId || '',
        resourceId:      entity.resourceId      || '',
        changeTypes:     entity.changeTypes ? entity.changeTypes.split(',').filter(Boolean) : [],
      })
    }
    return rules
  } catch {
    return []
  }
}

// Returns true if a diff change should be suppressed based on active rules
function isSuppressed(change, rules, resourceId, resourceGroupId) {
  const changePath  = (change.path || '').toLowerCase()
  const changeType  = (change.type || 'modified').toLowerCase()
  return rules.some(rule => {
    const ruleField = rule.fieldPath.toLowerCase()
    // Scope match: rule applies if no scope set, or scope matches
    const rgMatch  = !rule.resourceGroupId || (resourceGroupId || '').toLowerCase().includes(rule.resourceGroupId.toLowerCase())
    const resMatch = !rule.resourceId      || (resourceId      || '').toLowerCase() === rule.resourceId.toLowerCase()
    if (!rgMatch || !resMatch) return false
    // Change type match: suppress all types if none specified, else check list
    const typeMatch = !rule.changeTypes.length || rule.changeTypes.includes(changeType) || rule.changeTypes.includes('all')
    // Path match
    const pathMatch = changePath === ruleField || changePath.startsWith(ruleField + '.') || changePath.startsWith(ruleField + ' ')
    return pathMatch && typeMatch
  })
}

// getMonitorSessionsTableClient imported above from blobService — infrastructure stays in the service layer

// Generates a stable Table Storage row key from the session scope
function buildSessionRowKey(subscriptionId, resourceGroupId, resourceId) {
  const compositeKey = `${subscriptionId}:${resourceGroupId}:${resourceId || ''}`
  return Buffer.from(compositeKey).toString('base64url').slice(0, 512)
}


// ── runDriftCheck START ──────────────────────────────────────────────────────
// Full drift check pipeline: fetches live + baseline, diffs, classifies, runs AI, saves record, alerts
async function runDriftCheck(subscriptionId, resourceGroupId, resourceId, caller = '') {
  console.log('[runDriftCheck] starts — subscriptionId:', subscriptionId, 'rg:', resourceGroupId, 'resourceId:', resourceId)
  if (!subscriptionId || !resourceGroupId) throw new Error('runDriftCheck requires subscriptionId and resourceGroupId')
  const [currentLiveConfig, storedBaseline] = await Promise.all([
    getResourceConfig(subscriptionId, resourceGroupId, resourceId || null),
    getBaseline(subscriptionId, resourceId || resourceGroupId),
  ])

  const rawChanges       = storedBaseline?.resourceState ? diffObjects(storedBaseline.resourceState, currentLiveConfig) : []
  const suppressionRules = await loadSuppressionRules(subscriptionId)
  const resourceType     = currentLiveConfig?.type || ''
  const detectedChanges  = rawChanges.filter(c => !isSuppressed(c, suppressionRules, resourceId, resourceGroupId))
  const driftSeverity    = classifySeverity(detectedChanges)
  const driftRecord = {
    subscriptionId, resourceGroupId,
    resourceId:    resourceId || null,
    resourceGroup: resourceGroupId,
    liveState:     currentLiveConfig,
    baselineState: storedBaseline?.resourceState || null,
    differences:   detectedChanges,
    severity:      driftSeverity,
    changeCount:   detectedChanges.length,
    caller:        caller || '',
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
  const { subscriptionId, resourceGroupId, resourceId, caller } = req.body
  if (!subscriptionId || !resourceGroupId) return res.status(400).json({ error: 'subscriptionId and resourceGroupId required' })
  try { res.json(await runDriftCheck(subscriptionId, resourceGroupId, resourceId || null, caller || '')) }
  catch (compareError) { res.status(500).json({ error: compareError.message }) }
})
router.post('/monitor/start', async (req, res) => {
  const { subscriptionId, resourceGroupId, resourceId, intervalMs = 60000 } = req.body
  if (!subscriptionId || !resourceGroupId) return res.status(400).json({ error: 'subscriptionId and resourceGroupId required' })
  const sessionTableRowKey = buildSessionRowKey(subscriptionId, resourceGroupId, resourceId)
  try {
    await getMonitorSessionsTableClient().upsertEntity({
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
  if (!subscriptionId || !resourceGroupId) return res.status(400).json({ error: 'subscriptionId and resourceGroupId required' })
  const sessionTableRowKey = buildSessionRowKey(subscriptionId, resourceGroupId, resourceId)
  try {
    await getMonitorSessionsTableClient().upsertEntity({
      partitionKey: 'session', rowKey: sessionTableRowKey,
      subscriptionId, resourceGroupId, resourceId: resourceId || '',
      active: false,
    }, 'Merge')
    res.json({ monitoring: false, key: sessionTableRowKey })
  } catch (stopError) { res.status(500).json({ error: stopError.message }) }
})


// POST /api/compliance-impact
// Body: { differences: [...] } — maps diff to violated compliance controls
router.post('/compliance-impact', (req, res) => {
  console.log('[POST /compliance-impact] starts')
  const { differences } = req.body
  if (!Array.isArray(differences)) return res.status(400).json({ error: 'differences array required' })
  const controls = mapDiffToControls(differences)
  res.json(controls)
  console.log('[POST /compliance-impact] ends — controls:', controls.length)
})

module.exports = router