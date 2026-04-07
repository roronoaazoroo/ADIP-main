const router = require('express').Router()
const { saveBaseline } = require('../services/blobService')
const { getResourceConfig } = require('../services/azureResourceService')

// POST /api/seed-baseline
// Seeds the ACTUAL live config as the golden baseline (no hardcoded dummy data)
router.post('/seed-baseline', async (req, res) => {
  const { subscriptionId, resourceGroupId, resourceId } = req.body
  if (!subscriptionId || !resourceGroupId || !resourceId)
    return res.status(400).json({ error: 'subscriptionId, resourceGroupId and resourceId required' })
  try {
    const liveConfig = await getResourceConfig(subscriptionId, resourceGroupId, resourceId)
    const saved = await saveBaseline(subscriptionId, resourceGroupId, resourceId, liveConfig)
    res.json({ message: 'Golden baseline seeded from live config', baseline: saved })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
