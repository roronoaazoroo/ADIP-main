// ============================================================
// FILE: routes/subscriptions.js
// ============================================================
const router_subscriptions = require('express').Router()
const { listSubscriptions } = require('../services/azureResourceService')
 
// ── GET /api/subscriptions START ─────────────────────────────────────────────
// Returns all Azure subscriptions accessible to the current credential
router_subscriptions.get('/subscriptions', async (req, res) => {
  console.log('[GET /subscriptions] starts')
  try {
    const subs = await listSubscriptions()
    res.json(subs.map(s => ({ id: s.subscriptionId, name: s.displayName })))
    console.log('[GET /subscriptions] ends — returned:', subs.length)
  } catch (err) {
    console.log('[GET /subscriptions] ends — error:', err.message)
    res.status(500).json({ error: err.message })
  }
})
// ── GET /api/subscriptions END ───────────────────────────────────────────────
 
module.exports = router_subscriptions
