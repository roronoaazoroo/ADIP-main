'use strict'
const router_seed = require('express').Router()
const { saveBaseline } = require('../services/blobService')
const { getResourceConfig } = require('../services/azureResourceService')

// POST /api/seed-baseline — fetches current live ARM config and saves it as the golden baseline
router_seed.post('/seed-baseline', async (req, res) => {
  console.log('[POST /seed-baseline] starts')
  const { subscriptionId, resourceGroupId, resourceId } = req.body
  if (!subscriptionId || !resourceGroupId || !resourceId) {
    console.log('[POST /seed-baseline] ends — missing required fields')
    return res.status(400).json({ error: 'subscriptionId, resourceGroupId and resourceId required' })
  }
  try {
    const currentLiveConfig = await getResourceConfig(subscriptionId, resourceGroupId, resourceId)
    const savedBaselineDoc  = await saveBaseline(subscriptionId, resourceGroupId, resourceId, currentLiveConfig)
    res.json({ message: 'Golden baseline seeded from live config', baseline: savedBaselineDoc })
    console.log('[POST /seed-baseline] ends — resourceId:', resourceId)
  } catch (seedError) {
    console.log('[POST /seed-baseline] ends — error:', seedError.message)
    res.status(500).json({ error: seedError.message })
  }
})

module.exports = router_seed
