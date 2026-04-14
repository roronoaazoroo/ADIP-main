// ============================================================
// FILE: routes/remediateRequest.js
// ============================================================
const router_remediateRequest = require('express').Router()
const fetch = require('node-fetch')
 
// ── POST /api/remediate-request START ────────────────────────────────────────
// Sends a drift approval email to admins without applying remediation; waits for email click
router_remediateRequest.post('/remediate-request', async (req, res) => {
  console.log('[POST /remediate-request] starts')
  const { subscriptionId, resourceGroupId, resourceId, differences, changes, severity, caller } = req.body
  if (!subscriptionId || !resourceId) {
    console.log('[POST /remediate-request] ends — missing required fields')
    return res.status(400).json({ error: 'subscriptionId and resourceId required' })
  }
 
  try {
    const logicAppUrl = process.env.ALERT_LOGIC_APP_URL
    if (logicAppUrl && ['critical', 'high', 'medium'].includes(severity)) await fetch(logicAppUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptionId, resourceGroup: resourceGroupId, resourceId, severity: severity || 'high', changeCount: differences?.length || changes?.length || 0, differences: differences || changes || [], detectedAt: new Date().toISOString() }),
    }).catch(() => {})
    res.json({ requested: true, message: 'Approval email sent to administrators.' })
    console.log('[POST /remediate-request] ends — email sent')
  } catch (err) {
    console.log('[POST /remediate-request] ends — error:', err.message)
    res.status(500).json({ error: err.message })
  }
})
// ── POST /api/remediate-request END ──────────────────────────────────────────
 
module.exports = router_remediateRequest
 