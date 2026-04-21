'use strict'
const router_seed = require('express').Router()
const { saveBaseline: saveBaselineForSeed } = require('../services/blobService')
const { getResourceConfig: getResourceConfigForSeed } = require('../services/azureResourceService')

router_seed.post('/seed-baseline', async (req, res) => {
  const { subscriptionId, resourceGroupId, resourceId } = req.body
  if (!subscriptionId || !resourceGroupId || !resourceId)
    return res.status(400).json({ error: 'subscriptionId, resourceGroupId and resourceId required' })
  try {
    const currentLiveConfig = await getResourceConfigForSeed(subscriptionId, resourceGroupId, resourceId)
    const savedBaselineDoc  = await saveBaselineForSeed(subscriptionId, resourceGroupId, resourceId, currentLiveConfig)
    res.json({ message: 'Golden baseline seeded from live config', baseline: savedBaselineDoc })
  } catch (seedError) {
    res.status(500).json({ error: seedError.message })
  }
})

module.exports = router_seed
