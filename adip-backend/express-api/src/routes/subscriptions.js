'use strict'
// FILE: routes/subscriptions.js
// ROLE: GET /api/subscriptions — returns all Azure subscriptions the credential can access

const router_subscriptions = require('express').Router()
const { listSubscriptions } = require('../services/azureResourceService')
 
// ── GET /api/subscriptions START ─────────────────────────────────────────────
// Returns all Azure subscriptions accessible to the current credential
router_subscriptions.get('/subscriptions', async (req, res) => {
  console.log('[GET /subscriptions] starts')
  try {
    const subscriptionList = await listSubscriptions()
    // Return only the fields the frontend needs
    res.json(subscriptionList.map(subscription => ({ id: subscription.subscriptionId, name: subscription.displayName })))
    console.log('[GET /subscriptions] ends — returned:', subscriptionList.length)
  } catch (fetchError) {
    console.log('[GET /subscriptions] ends — error:', fetchError.message)
    res.status(500).json({ error: fetchError.message })
  }
})
// ── GET /api/subscriptions END ───────────────────────────────────────────────
 
module.exports = router_subscriptions
