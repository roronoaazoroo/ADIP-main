const router = require('express').Router()
const { saveGenomeSnapshot, listGenomeSnapshots, getGenomeSnapshot, saveBaseline } = require('../services/blobService')
const { getResourceConfig, getApiVersion } = require('../services/azureResourceService')
const { ResourceManagementClient } = require('@azure/arm-resources')
const { DefaultAzureCredential } = require('@azure/identity')

// GET /api/genome?subscriptionId=&resourceId=&limit=
router.get('/genome', async (req, res) => {
  const { subscriptionId, resourceId, limit } = req.query
  if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' })
  try {
    const snapshots = await listGenomeSnapshots(subscriptionId, resourceId, Number(limit) || 50)
    res.json(snapshots)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/genome/save — save current live state as a genome snapshot
router.post('/genome/save', async (req, res) => {
  const { subscriptionId, resourceGroupId, resourceId, label } = req.body
  if (!subscriptionId || !resourceGroupId || !resourceId)
    return res.status(400).json({ error: 'subscriptionId, resourceGroupId and resourceId required' })
  try {
    const liveConfig = await getResourceConfig(subscriptionId, resourceGroupId, resourceId)
    const snapshot = await saveGenomeSnapshot(subscriptionId, resourceId, liveConfig, label || '')
    res.json(snapshot)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/genome/promote — promote a snapshot to golden baseline
router.post('/genome/promote', async (req, res) => {
  const { subscriptionId, resourceGroupId, resourceId, blobKey } = req.body
  if (!subscriptionId || !resourceId || !blobKey)
    return res.status(400).json({ error: 'subscriptionId, resourceId and blobKey required' })
  try {
    const snapshot = await getGenomeSnapshot(blobKey)
    if (!snapshot?.resourceState) return res.status(404).json({ error: 'Snapshot not found' })
    await saveBaseline(subscriptionId, resourceGroupId || '', resourceId, snapshot.resourceState)
    res.json({ promoted: true, resourceId, blobKey })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/genome/rollback — revert resource to a snapshot via ARM PUT
router.post('/genome/rollback', async (req, res) => {
  const { subscriptionId, resourceGroupId, resourceId, blobKey } = req.body
  if (!subscriptionId || !resourceGroupId || !resourceId || !blobKey)
    return res.status(400).json({ error: 'subscriptionId, resourceGroupId, resourceId and blobKey required' })
  try {
    const snapshot = await getGenomeSnapshot(blobKey)
    if (!snapshot?.resourceState) return res.status(404).json({ error: 'Snapshot not found' })

    const VOLATILE = ['etag','changedTime','createdTime','provisioningState','lastModifiedAt','systemData','_ts','_etag','_childConfig']
    function strip(obj) {
      if (Array.isArray(obj)) return obj.map(strip)
      if (obj && typeof obj === 'object')
        return Object.fromEntries(Object.entries(obj).filter(([k]) => !VOLATILE.includes(k)).map(([k,v]) => [k, strip(v)]))
      return obj
    }

    const state      = strip(snapshot.resourceState)
    const credential = new DefaultAzureCredential()
    const armClient  = new ResourceManagementClient(credential, subscriptionId)
    const parts      = resourceId.split('/')
    const rgName     = parts[4], provider = parts[6], type = parts[7], name = parts[8]
    const apiVersion = await getApiVersion(subscriptionId, provider, type)

    let location = state.location
    if (!location) {
      try { const live = await armClient.resources.get(rgName, provider, '', type, name, apiVersion); location = live.location } catch { location = 'eastus' }
    }

    await armClient.resources.beginCreateOrUpdateAndWait(rgName, provider, '', type, name, apiVersion, { ...state, location })
    res.json({ rolledBack: true, resourceId, blobKey, savedAt: snapshot.savedAt })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
