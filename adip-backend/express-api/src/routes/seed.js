'use strict'
const router_seed = require('express').Router()
const { saveBaseline: saveBaselineForSeed } = require('../services/blobService')
const { getResourceConfig: getResourceConfigForSeed } = require('../services/azureResourceService')

router_seed.post('/seed-baseline', async (req, res) => {
  const { subscriptionId, resourceGroupId, resourceId } = req.body
  if (!subscriptionId || !resourceGroupId || !resourceId)
    return res.status(400).json({ error: 'subscriptionId, resourceGroupId and resourceId required' })
  try {
    const liveConfig = await getResourceConfigForSeed(subscriptionId, resourceGroupId, resourceId)
    const saved = await saveBaselineForSeed(subscriptionId, resourceGroupId, resourceId, liveConfig)
    res.json({ message: 'Golden baseline seeded from live config', baseline: saved })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router_seed
