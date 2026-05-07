// ============================================================
// FILE: adip-backend/express-api/src/routes/recommendations.js
// ROLE: Intent-based AI recommendations for aggregated drift
//
// POST /api/recommendations — generates prioritized recommendations
//   Body: { subscriptionId, resourceGroupId, resourceId, intent, differences }
//   Returns: [{ priority, field, action, reason, autoFixAvailable, manualGuide }]
// ============================================================
'use strict'
const router = require('express').Router()

const FUNCTION_APP_URL = process.env.FUNCTION_APP_URL?.replace(/\/$/, '')

router.post('/recommendations', async (req, res) => {
  console.log('[POST /recommendations] starts')
  const { subscriptionId, resourceGroupId, resourceId, intent, differences } = req.body

  if (!differences?.length) return res.json([])
  if (!intent) return res.status(400).json({ error: 'intent required (security|cost|compliance)' })

  const resourceName = (resourceId || resourceGroupId || '').split('/').pop()
  const resourceType = req.body.resourceType || ''

  const systemPrompt = `You are an Azure infrastructure advisor. The user's priority is: ${intent.toUpperCase()}.
Analyze the following configuration drift and return a JSON array of recommendations.
Each item must have: { "priority": "critical|high|medium|keep", "field": "field path", "action": "revert|keep", "reason": "one sentence why", "autoFixAvailable": true/false, "manualGuide": { "portal": "step by step portal instructions", "cli": "az cli command" } }
Sort by priority (critical first). Mark changes that ALIGN with the user's intent as "keep".
For security intent: flag anything that weakens network isolation, encryption, or access controls.
For cost intent: flag anything that increases monthly spend.
For compliance intent: flag anything that violates CIS Azure, NIST 800-53, or ISO 27001 controls.
Return ONLY valid JSON array, no markdown.`

  const userContent = `Resource: ${resourceName} (${resourceType})
Resource Group: ${resourceGroupId}
User Intent: ${intent}
Current drift from baseline (net changes):
${differences.map(d => `- ${d.type} ${d.path}: ${JSON.stringify(d.oldValue)?.slice(0,30)} → ${JSON.stringify(d.newValue)?.slice(0,30)}`).join('\n')}`

  try {
    // Call AI via Function App
    if (!FUNCTION_APP_URL) throw new Error('FUNCTION_APP_URL not configured')
    const fetch = require('node-fetch')
    const aiResponse = await fetch(`${FUNCTION_APP_URL}/aiOperations?operation=recommend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt, userContent }),
      timeout: 30000,
    })

    if (!aiResponse.ok) throw new Error(`AI returned ${aiResponse.status}`)
    const aiText = await aiResponse.text()

    // Parse JSON from AI response (may have markdown wrapping)
    const jsonMatch = aiText.match(/\[[\s\S]*\]/)
    const recommendations = jsonMatch ? JSON.parse(jsonMatch[0]) : []

    res.json(recommendations)
    console.log('[POST /recommendations] ends — count:', recommendations.length)
  } catch (error) {
    console.log('[POST /recommendations] error:', error.message)
    // Fallback: generate basic recommendations without AI
    const fallback = differences.map(d => ({
      priority: d.type === 'removed' ? 'critical' : 'medium',
      field: d.path,
      action: 'revert',
      reason: `${d.path} was ${d.type}`,
      autoFixAvailable: true,
      manualGuide: { portal: `Azure Portal → Resource → find ${d.path?.split(' → ').pop()} setting`, cli: `az resource update` },
    }))
    res.json(fallback)
  }
})

module.exports = router
