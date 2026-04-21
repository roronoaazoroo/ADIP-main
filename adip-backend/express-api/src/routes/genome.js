'use strict'
const router = require('express').Router()
const { saveGenomeSnapshot, listGenomeSnapshots, getGenomeSnapshot, saveBaseline, deleteGenomeSnapshot } = require('../services/blobService')
const { getResourceConfig, getApiVersion } = require('../services/azureResourceService')
const { strip } = require('../shared/diff')
const { ResourceManagementClient } = require('@azure/arm-resources')
const { DefaultAzureCredential }   = require('@azure/identity')

// Is this a full ARM resource ID or just a resource group name?
const isArmId = (id) => id && id.startsWith('/subscriptions/')


// ── GET /api/genome START ────────────────────────────────────────────────────
// Returns all versioned configuration snapshots for a resource, sorted newest-first
router.get('/genome', async (req, res) => {
  console.log('[GET /genome] starts')
  const { subscriptionId, resourceId, limit } = req.query
  if (!subscriptionId) {
    console.log('[GET /genome] ends — missing subscriptionId')
    return res.status(400).json({ error: 'subscriptionId required' })
  }
  try {
    res.json(await listGenomeSnapshots(subscriptionId, resourceId, Number(limit) || 50))
  } catch (err) { res.status(500).json({ error: err.message }) }
})
// ── GET /api/genome END ──────────────────────────────────────────────────────

// POST /api/genome/save
router.post('/genome/save', async (req, res) => {
  console.log('[POST /genome/save] starts')
  const { subscriptionId, resourceGroupId, resourceId, label } = req.body
  if (!subscriptionId || !resourceGroupId || !resourceId) {
    console.log('[POST /genome/save] ends — missing required fields')
    return res.status(400).json({ error: 'subscriptionId, resourceGroupId and resourceId required' })
  }
  try {
    // For full ARM IDs fetch the specific resource; for RG-level fetch the whole group
    const liveConfig = isArmId(resourceId)
      ? await getResourceConfig(subscriptionId, resourceGroupId, resourceId)
      : await getResourceConfig(subscriptionId, resourceGroupId, null)

    const snapshot = await saveGenomeSnapshot(subscriptionId, resourceId, liveConfig, label || '')
    res.json(snapshot)
  } catch (err) { res.status(500).json({ error: err.message }) }
})
// ── POST /api/genome/save END ────────────────────────────────────────────────

// POST /api/genome/promote — make snapshot the golden baseline
router.post('/genome/promote', async (req, res) => {
  console.log('[POST /genome/promote] starts')
  const { subscriptionId, resourceGroupId, resourceId, blobKey } = req.body
  if (!subscriptionId || !resourceId || !blobKey) {
    console.log('[POST /genome/promote] ends — missing required fields')
    return res.status(400).json({ error: 'subscriptionId, resourceId and blobKey required' })
  }
  try {
    const snapshot = await getGenomeSnapshot(blobKey)
    if (!snapshot?.resourceState) {
      console.log('[POST /genome/promote] ends — snapshot not found')
      return res.status(404).json({ error: 'Snapshot not found' })
    }
    await saveBaseline(subscriptionId, resourceGroupId || '', resourceId, snapshot.resourceState)

    // Mark this snapshot as the active baseline; clear the flag on all others for this resource
    try {
      const genomeIndexTable = require('@azure/data-tables').TableClient.fromConnectionString(
        process.env.STORAGE_CONNECTION_STRING, 'genomeIndex'
      )
      const promotedTimestamp = new Date().toISOString()
      for await (const indexEntity of genomeIndexTable.listEntities({ queryOptions: { filter: `PartitionKey eq '${subscriptionId}' and resourceId eq '${resourceId}'` } })) {
        await genomeIndexTable.upsertEntity({
          ...indexEntity,
          isCurrentBaseline: indexEntity.blobKey === blobKey,
          promotedAt:        indexEntity.blobKey === blobKey ? promotedTimestamp : null,
        }, 'Replace').catch(() => {})
      }
    } catch { /* non-fatal */ }

    res.json({ promoted: true, resourceId, blobKey })
  } catch (err) { res.status(500).json({ error: err.message }) }
})
// ── POST /api/genome/promote END ─────────────────────────────────────────────

// POST /api/genome/rollback — revert resource to snapshot via ARM PUT
router.post('/genome/rollback', async (req, res) => {
  console.log('[POST /genome/rollback] starts')
  const { subscriptionId, resourceGroupId, resourceId, blobKey } = req.body
  if (!subscriptionId || !resourceGroupId || !resourceId || !blobKey) {
    console.log('[POST /genome/rollback] ends — missing required fields')
    return res.status(400).json({ error: 'subscriptionId, resourceGroupId, resourceId and blobKey required' })}
  try {
    const snapshot = await getGenomeSnapshot(blobKey)
    if (!snapshot?.resourceState) {
      console.log('[POST /genome/rollback] ends — snapshot not found')
      return res.status(404).json({ error: 'Snapshot not found' })
    }

    const credential = new DefaultAzureCredential()
    const armClient  = new ResourceManagementClient(credential, subscriptionId)

    // Resource group snapshot: rollback each resource individually
    if (!isArmId(resourceId) && snapshot.resourceState.resources) {
      const results = []
      for (const r of snapshot.resourceState.resources) {
        if (!r.id) continue
        try {
          const state    = strip(r)
          const parts    = r.id.split('/')
          const rgName   = parts[4], provider = parts[6], type = parts[7], name = parts[8]
          if (!rgName || !provider || !type || !name) continue
          const apiVersion = await getApiVersion(subscriptionId, provider, type)
          const location   = state.location || (await armClient.resources.get(rgName, provider, '', type, name, apiVersion).catch(() => ({}))).location || 'eastus'
          await armClient.resources.beginCreateOrUpdateAndWait(rgName, provider, '', type, name, apiVersion, { ...state, location })
          results.push({ resourceId: r.id, status: 'rolledBack' })
        } catch (e) {
          results.push({ resourceId: r.id, status: 'failed', error: e.message })
        }
      }
      return res.json({ rolledBack: true, resourceId, blobKey, savedAt: snapshot.savedAt, results })
    }

    // Single resource rollback
    const state      = strip(snapshot.resourceState)
    const parts      = resourceId.split('/')
    const rgName = parts[4], provider = parts[6], type = parts[7], name = parts[8]
    const apiVersion = await getApiVersion(subscriptionId, provider, type)
    let location = state.location
    if (!location) {
      try { location = (await armClient.resources.get(rgName, provider, '', type, name, apiVersion)).location }
      catch { location = 'eastus' }
    }
    await armClient.resources.beginCreateOrUpdateAndWait(rgName, provider, '', type, name, apiVersion, { ...state, location })
    // Mark this snapshot as active rollback; clear flag on all others for this resource
    try {
      const tc = require('@azure/data-tables').TableClient.fromConnectionString(
        process.env.STORAGE_CONNECTION_STRING, 'genomeIndex'
      )
      const now = new Date().toISOString()
      for await (const entity of tc.listEntities({ queryOptions: { filter: `PartitionKey eq '${subscriptionId}' and resourceId eq '${resourceId}'` } })) {
        await tc.upsertEntity({ ...entity, rolledBackAt: entity.blobKey === blobKey ? now : null }, 'Replace').catch(() => {})
      }
    } catch { /* non-fatal */ }
    res.json({ rolledBack: true, resourceId, blobKey, savedAt: snapshot.savedAt })
  } catch (err) { res.status(500).json({ error: err.message }) }
})
// ── POST /api/genome/rollback END ────────────────────────────────────────────

// POST /api/genome/delete
router.post('/genome/delete', async (req, res) => {
  const { subscriptionId, blobKey } = req.body
  if (!subscriptionId || !blobKey) return res.status(400).json({ error: 'subscriptionId and blobKey required' })
  try {
    await deleteGenomeSnapshot(subscriptionId, blobKey)
    res.json({ deleted: true, blobKey })
  } catch (err) { res.status(500).json({ error: err.message }) }
})

module.exports = router