const router = require('express').Router()
const { upsertBaseline } = require('../services/cosmosService')

// POST /api/baselines/upload
// Accepts a custom golden baseline JSON uploaded from the frontend
router.post('/baselines/upload', async (req, res) => {
  const { subscriptionId, resourceGroupId, resourceId, baselineData } = req.body

  // Reject invalid payloads before touching Cosmos DB (saves RUs)
  if (!subscriptionId || !resourceId || !baselineData) {
    return res.status(400).json({ error: 'subscriptionId, resourceId and baselineData are required' })
  }
  if (typeof baselineData !== 'object' || Array.isArray(baselineData)) {
    return res.status(400).json({ error: 'baselineData must be a JSON object' })
  }

  try {
    const saved = await upsertBaseline(subscriptionId, resourceGroupId || '', resourceId, baselineData)
    res.json({ uploaded: true, id: saved?.id, resourceId })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
