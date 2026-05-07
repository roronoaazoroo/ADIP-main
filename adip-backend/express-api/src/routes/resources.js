// FILE: routes/resources.js
// ROLE: GET /api/subscriptions/:id/resource-groups/:rg/resources — lists all resources in an RG

'use strict'
const router_resources = require('express').Router()
const { listResources } = require('../services/azureResourceService')
 
//  GET /api/subscriptions/:id/resource-groups/:rg/resources START 
// Lists all resources in the given resource group
router_resources.get('/subscriptions/:subscriptionId/resource-groups/:resourceGroupId/resources', async (req, res) => {
  console.log('[GET /.../resources] starts — rg:', req.params.resourceGroupId)
  try {
    const resourceList = await listResources(req.params.subscriptionId, req.params.resourceGroupId)
    // Return only id, name, type — the frontend doesn't need the full ARM object
    res.json(resourceList.map(resource => ({ id: resource.id, name: resource.name, type: resource.type })))
    console.log('[GET /.../resources] ends — returned:', resourceList.length)
  } catch (fetchError) {
    console.log('[GET /.../resources] ends — error:', fetchError.message)
    res.status(500).json({ error: fetchError.message })
  }
})
//  GET /api/subscriptions/:id/resource-groups/:rg/resources END 
 
module.exports = router_resources
 
 