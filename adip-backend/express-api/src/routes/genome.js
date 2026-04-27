'use strict'
// All imports at top — functions defined after dependencies are loaded
const router      = require('express').Router()
const { TableClient } = require('@azure/data-tables')
const { saveGenomeSnapshot, listGenomeSnapshots, getGenomeSnapshot, saveBaseline, deleteGenomeSnapshot } = require('../services/blobService')
const { getResourceConfig, getApiVersion } = require('../services/azureResourceService')
const { strip } = require('../shared/diff')
const { ResourceManagementClient } = require('@azure/arm-resources')
const { DefaultAzureCredential }   = require('@azure/identity')

// Is this a full ARM resource ID or just a resource group name?
const isArmId = (id) => id && id.startsWith('/subscriptions/')

// Returns a Table Storage client for the genomeIndex table
function getGenomeIndexTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'genomeIndex')
}

// Updates a flag field on all genomeIndex entities for a resource.
// Sets flagValue on the matching blobKey, null on all others.
// Used by promote (isCurrentBaseline) and rollback (rolledBackAt).
async function updateGenomeFlag(subscriptionId, resourceId, blobKey, flagField, flagValue) {
  const genomeTable = getGenomeIndexTable()
  const filter = `PartitionKey eq '${subscriptionId}' and resourceId eq '${resourceId}'`
  for await (const entity of genomeTable.listEntities({ queryOptions: { filter } })) {
    await genomeTable.upsertEntity({
      ...entity,
      [flagField]: entity.blobKey === blobKey ? flagValue : null,
    }, 'Replace').catch(flagUpdateError => {
      console.warn('[updateGenomeFlag] non-fatal upsert error:', flagUpdateError.message)
    })
  }
}

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
  } catch (routeError) { res.status(500).json({ error: routeError.message }) }
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
  } catch (routeError) { res.status(500).json({ error: routeError.message }) }
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

    // Mark this snapshot as the active baseline; clear the flag on all others
    await updateGenomeFlag(subscriptionId, resourceId, blobKey, 'isCurrentBaseline', true).catch(() => {})
    await updateGenomeFlag(subscriptionId, resourceId, blobKey, 'promotedAt', new Date().toISOString()).catch(() => {})

    res.json({ promoted: true, resourceId, blobKey })
  } catch (routeError) { res.status(500).json({ error: routeError.message }) }
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
          const location   = state.location || (await armClient.resources.get(rgName, provider, '', type, name, apiVersion).catch(() => ({}))).location || process.env.DEFAULT_AZURE_LOCATION || 'eastus'
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
      catch { location = process.env.DEFAULT_AZURE_LOCATION || 'eastus' }
    }
    await armClient.resources.beginCreateOrUpdateAndWait(rgName, provider, '', type, name, apiVersion, { ...state, location })
    // Mark this snapshot as the active rollback; clear the flag on all others
    await updateGenomeFlag(subscriptionId, resourceId, blobKey, 'rolledBackAt', new Date().toISOString()).catch(() => {})
    res.json({ rolledBack: true, resourceId, blobKey, savedAt: snapshot.savedAt })
  } catch (routeError) { res.status(500).json({ error: routeError.message }) }
})
// ── POST /api/genome/rollback END ────────────────────────────────────────────

// GET /api/genome/history — returns the full activity history for a resource's genomes
// Includes: snapshots created, snapshots deleted (tracked via deletedAt), rollbacks, and baseline promotions
// Used by the Genome History tab on GenomePage
router.get('/genome/history', async (req, res) => {
  console.log('[GET /genome/history] starts')
  const { subscriptionId, resourceId } = req.query
  if (!subscriptionId || !resourceId) {
    console.log('[GET /genome/history] ends — missing required params')
    return res.status(400).json({ error: 'subscriptionId and resourceId required' })
  }
  try {
    const genomeTable = getGenomeIndexTable()
    const filter = `PartitionKey eq '${subscriptionId}' and resourceId eq '${resourceId}'`
    const historyEvents = []

    for await (const entity of genomeTable.listEntities({ queryOptions: { filter } })) {
      const snapshotLabel = entity.label || 'snapshot'
      const blobKey       = entity.blobKey

      // Event: snapshot created
      historyEvents.push({
        eventType:  'created',
        eventAt:    entity.savedAt,
        blobKey,
        snapshotLabel,
        isCurrentBaseline: entity.isCurrentBaseline || false,
      })

      // Event: rolled back to this snapshot
      if (entity.rolledBackAt) {
        historyEvents.push({
          eventType:  'rolledBack',
          eventAt:    entity.rolledBackAt,
          blobKey,
          snapshotLabel,
          isCurrentBaseline: entity.isCurrentBaseline || false,
        })
      }

      // Event: promoted to baseline
      if (entity.promotedAt) {
        historyEvents.push({
          eventType:  'promoted',
          eventAt:    entity.promotedAt,
          blobKey,
          snapshotLabel,
          isCurrentBaseline: entity.isCurrentBaseline || false,
        })
      }

      // Event: deleted (tracked via deletedAt field set on soft-delete)
      if (entity.deletedAt) {
        historyEvents.push({
          eventType:  'deleted',
          eventAt:    entity.deletedAt,
          blobKey,
          snapshotLabel,
          isCurrentBaseline: false,
        })
      }
    }

    // Sort all events newest first
    historyEvents.sort((a, b) => new Date(b.eventAt) - new Date(a.eventAt))
    res.json(historyEvents)
    console.log('[GET /genome/history] ends — found:', historyEvents.length, 'events')
  } catch (routeError) { res.status(500).json({ error: routeError.message }) }
})

// POST /api/genome/delete
router.post('/genome/delete', async (req, res) => {
  const { subscriptionId, blobKey } = req.body
  if (!subscriptionId || !blobKey) return res.status(400).json({ error: 'subscriptionId and blobKey required' })
  try {
    // Record deletedAt on the Table entity before removing the blob
    // This preserves the deletion event in genome history
    await updateGenomeFlag(subscriptionId, blobKey, blobKey, 'deletedAt', new Date().toISOString()).catch(() => {})
    await deleteGenomeSnapshot(subscriptionId, blobKey)
    res.json({ deleted: true, blobKey })
  } catch (routeError) { res.status(500).json({ error: routeError.message }) }
})

module.exports = router