const router = require('express').Router()
const { explainDrift, reclassifySeverity, getRemediationRecommendation, detectAnomalies } = require('../services/aiService')
const { getDriftRecords } = require('../services/cosmosService')

// POST /api/ai/explain — Feature 1: plain-English drift explanation
router.post('/ai/explain', async (req, res) => {
  try {
    const explanation = await explainDrift(req.body)
    res.json({ explanation })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/ai/severity — Feature 2: AI severity re-classification
router.post('/ai/severity', async (req, res) => {
  try {
    const result = await reclassifySeverity(req.body)
    res.json(result || {})
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/ai/recommend — Feature 3: remediation recommendation
router.post('/ai/recommend', async (req, res) => {
  try {
    const recommendation = await getRemediationRecommendation(req.body)
    res.json({ recommendation })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/ai/anomalies?subscriptionId= — Feature 5: anomaly detection
router.get('/ai/anomalies', async (req, res) => {
  const { subscriptionId } = req.query
  if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' })
  try {
    const records   = await getDriftRecords({ subscriptionId, limit: 50 })
    const anomalies = await detectAnomalies(records)
    res.json({ anomalies })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
