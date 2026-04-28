'use strict'
// FILE: routes/policy.js
// ROLE: GET /api/policy/compliance — returns Azure Policy compliance state (read-only)

const router_policy = require('express').Router()
const { getPolicyCompliance } = require('../services/policyService')
 
// ── GET /api/policy/compliance START ─────────────────────────────────────────
// Returns Azure Policy compliance state for a resource or resource group (read-only)
router_policy.get('/policy/compliance', async (req, res) => {
  console.log('[GET /policy/compliance] starts')
  const { subscriptionId, resourceGroupId, resourceId } = req.query
  if (!subscriptionId || !resourceGroupId) {
    console.log('[GET /policy/compliance] ends — missing required params')
    return res.status(400).json({ error: 'subscriptionId and resourceGroupId required' })
  }
  try {
    const complianceResult = await getPolicyCompliance(subscriptionId, resourceGroupId, resourceId || null)
    res.json(complianceResult)
    console.log('[GET /policy/compliance] ends')
  } catch (policyError) {
    // 404 = no policies assigned to this scope — return empty result, not an error
    if (policyError.statusCode === 404 || policyError.code === 'ResourceNotFound') {
      console.log('[GET /policy/compliance] ends — no policies assigned')
      return res.json({ total: 0, nonCompliant: 0, compliant: 0, summary: 'no-policies', violations: [] })
    }
    console.log('[GET /policy/compliance] ends — error:', policyError.message)
    res.status(500).json({ error: policyError.message })
  }
})
// ── GET /api/policy/compliance END ───────────────────────────────────────────
 
module.exports = router_policy
 
 