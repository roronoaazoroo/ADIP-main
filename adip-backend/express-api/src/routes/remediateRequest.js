const router  = require('express').Router()
const { sendDriftAlert } = require('../services/alertService')

// POST /api/remediate-request
// Called by frontend "Auto Remediate" button — sends approval email, returns immediately
router.post('/remediate-request', async (req, res) => {
  const { subscriptionId, resourceGroupId, resourceId, differences, changes, severity, caller } = req.body
  if (!subscriptionId || !resourceId)
    return res.status(400).json({ error: 'subscriptionId and resourceId required' })

  try {
    await sendDriftAlert({
      subscriptionId,
      resourceGroup: resourceGroupId,
      resourceId,
      severity:      severity || 'high',
      changeCount:   differences?.length || changes?.length || 0,
      differences:   differences || changes || [],
      changes:       changes || differences || [],
      caller:        caller || 'unknown',
      detectedAt:    new Date().toISOString(),
    })
    res.json({ requested: true, message: 'Approval email sent to administrators.' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
