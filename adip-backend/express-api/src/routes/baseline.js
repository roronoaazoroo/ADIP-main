'use strict'
// FILE: routes/baseline.js
// ROLE: GET /api/baselines — fetch golden baseline | POST

const router_baseline = require('express').Router()
const { getBaseline, saveBaseline } = require('../services/blobService')
 
//  GET /api/baselines START 
// Returns the active golden baseline for a given resource
router_baseline.get('/baselines', async (req, res) => {
  console.log('[GET /baselines] starts')
  const { subscriptionId, resourceId } = req.query
  if (!subscriptionId) {
    console.log('[GET /baselines] ends — missing subscriptionId')
    return res.status(400).json({ error: 'subscriptionId required' })
  }
  try {
    const baselineDocument = await getBaseline(subscriptionId, resourceId)
    res.json(baselineDocument || null)
    console.log('[GET /baselines] ends')
  } catch (fetchError) {
    console.log('[GET /baselines] ends — error:', fetchError.message)
    res.status(500).json({ error: fetchError.message })
  }
})
//  GET /api/baselines END 
 
//  POST /api/baselines START 
// Saves a new golden baseline for a resource
router_baseline.post('/baselines', async (req, res) => {
  console.log('[POST /baselines] starts')
  const { subscriptionId, resourceGroupId, resourceId, resourceState } = req.body
  if (!subscriptionId || !resourceId || !resourceState) {
    console.log('[POST /baselines] ends — missing required fields')
    return res.status(400).json({ error: 'subscriptionId, resourceId and resourceState required' })
  }
  try {
    const savedBaselineDocument = await saveBaseline(subscriptionId, resourceGroupId, resourceId, resourceState)
    res.json(savedBaselineDocument)
    console.log('[POST /baselines] ends')
  } catch (saveError) {
    console.log('[POST /baselines] ends — error:', saveError.message)
    res.status(500).json({ error: saveError.message })
  }
})
//  POST /api/baselines END 
 
module.exports = router_baseline
 