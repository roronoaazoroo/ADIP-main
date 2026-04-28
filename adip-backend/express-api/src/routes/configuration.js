 
'use strict'
// FILE: routes/configuration.js
// ROLE: GET /api/configuration — fetches full live ARM config for a resource or resource group

const router_configuration = require('express').Router()
const { getResourceConfig } = require('../services/azureResourceService')
 
// ── GET /api/configuration START ─────────────────────────────────────────────
// Fetches the live ARM configuration for a resource or all resources in a resource group
router_configuration.get('/configuration', async (req, res) => {
  console.log('[GET /configuration] starts')
  const { subscriptionId, resourceGroupId, resourceId } = req.query
  if (!subscriptionId || !resourceGroupId) {
    console.log('[GET /configuration] ends — missing required params')
    return res.status(400).json({ error: 'subscriptionId and resourceGroupId required' })
  }
  // Sanitise inputs — prevent OData injection via single-quote characters
  if (subscriptionId.includes("'") || resourceGroupId.includes("'")) {
    return res.status(400).json({ error: 'Invalid characters in subscriptionId or resourceGroupId' })
  }
  try {
    const liveArmConfig = await getResourceConfig(subscriptionId, resourceGroupId, resourceId || null)
    res.json(liveArmConfig)
    console.log('[GET /configuration] ends')
  } catch (fetchError) {
    console.log('[GET /configuration] ends — error:', fetchError.message)
    res.status(500).json({ error: fetchError.message })
  }
})
// ── GET /api/configuration END ───────────────────────────────────────────────
 
module.exports = router_configuration
 