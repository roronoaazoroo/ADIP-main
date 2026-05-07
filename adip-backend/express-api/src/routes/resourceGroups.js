// FILE: routes/resourceGroups.js
// ROLE: GET /api/subscriptions/:id/resource-groups — lists all RGs in a subscription

'use strict'
const router_resourceGroups = require('express').Router()
const { listResourceGroups } = require('../services/azureResourceService')
 
//  GET /api/subscriptions/:id/resource-groups START 
// Lists all resource groups in the given subscription
router_resourceGroups.get('/subscriptions/:subscriptionId/resource-groups', async (req, res) => {
  console.log('[GET /subscriptions/:id/resource-groups] starts — subscriptionId:', req.params.subscriptionId)
  try {
    const resourceGroupList = await listResourceGroups(req.params.subscriptionId)
    res.json(resourceGroupList.map(resourceGroup => ({ id: resourceGroup.name, name: resourceGroup.name, location: resourceGroup.location })))
    console.log('[GET /subscriptions/:id/resource-groups] ends — returned:', resourceGroupList.length)
  } catch (fetchError) {
    console.log('[GET /subscriptions/:id/resource-groups] ends — error:', fetchError.message)
    res.status(500).json({ error: fetchError.message })
  }
})
//  GET /api/subscriptions/:id/resource-groups END 
 
module.exports = router_resourceGroups
 