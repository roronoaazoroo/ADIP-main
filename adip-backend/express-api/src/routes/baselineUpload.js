'use strict'
// FILE: routes/baselineUpload.js
// ROLE: POST /api/baselines/upload — accepts a JSON file as the new golden baseline

const router_baselineUpload = require('express').Router()
const { saveBaseline } = require('../services/blobService')
 
// ── POST /api/baselines/upload START ─────────────────────────────────────────
// Accepts a custom JSON golden baseline uploaded from the frontend (or ARM template)
router_baselineUpload.post('/baselines/upload', async (req, res) => {
  console.log('[POST /baselines/upload] starts')
  const { subscriptionId, resourceGroupId, resourceId, baselineData } = req.body
 
  if (!subscriptionId || !resourceId || !baselineData) {
    console.log('[POST /baselines/upload] ends — missing required fields')
    return res.status(400).json({ error: 'subscriptionId, resourceId and baselineData are required' })
  }
  if (typeof baselineData !== 'object' || Array.isArray(baselineData)) {
    console.log('[POST /baselines/upload] ends — baselineData is not a JSON object')
    return res.status(400).json({ error: 'baselineData must be a JSON object' })
  }
  if (Object.keys(baselineData).length === 0) {
    console.log('[POST /baselines/upload] ends — baselineData is empty')
    return res.status(400).json({ error: 'baselineData must not be empty' })
  }
 
  try {
    const savedBaselineDocument = await saveBaseline(subscriptionId, resourceGroupId || '', resourceId, baselineData)
    res.json({ uploaded: true, id: savedBaselineDocument?.id, resourceId })
    console.log('[POST /baselines/upload] ends — resourceId:', resourceId)
  } catch (uploadError) {
    console.log('[POST /baselines/upload] ends — error:', uploadError.message)
    res.status(500).json({ error: uploadError.message })
  }
})
// ── POST /api/baselines/upload END ───────────────────────────────────────────
 
module.exports = router_baselineUpload