// ============================================================
// FILE: adip-backend/express-api/src/routes/manualGuide.js
// ROLE: AI-generated step-by-step manual fix guide
//
// POST /api/manual-guide
//   Body: { resourceId, resourceType, resourceName, differences }
//   Returns: { guide: [{ title, description, portal, cli }] }
// ============================================================
'use strict'
const router = require('express').Router()

const FUNCTION_APP_URL = process.env.FUNCTION_APP_URL?.replace(/\/$/, '')

router.post('/manual-guide', async (req, res) => {
  console.log('[POST /manual-guide] starts')
  const { resourceId, resourceType, resourceName, differences } = req.body

  if (!differences?.length) return res.json({ guide: [] })

  const changesDescription = differences.map(d => {
    const field = (d.path || '').split(' → ').pop() || d.path
    if (d.type === 'removed') return `"${field}" was removed (was: ${JSON.stringify(d.oldValue)?.slice(0, 30)})`
    if (d.type === 'added') return `"${field}" was added with value: ${JSON.stringify(d.newValue)?.slice(0, 30)}`
    return `"${field}" changed from ${JSON.stringify(d.oldValue)?.slice(0, 25)} to ${JSON.stringify(d.newValue)?.slice(0, 25)}`
  }).join('\n')

  const systemPrompt = `You are an Azure infrastructure expert helping a developer manually fix configuration drift.
Generate a clear, simple, step-by-step guide to revert each change.
Return a JSON array where each item has: { "title": "short action title", "description": "explain what this fixes and why", "portal": "exact Azure Portal navigation path with clicks", "cli": "exact az CLI command to run" }
Be specific — include exact menu names, blade names, and setting labels for Portal steps.
For CLI commands, use the actual resource ID and property paths.
Keep language simple — any developer should be able to follow this without Azure expertise.
Return ONLY valid JSON array, no markdown.`

  const userContent = `Resource: ${resourceName} (${resourceType || 'unknown type'})
Resource ID: ${resourceId || 'N/A'}

Changes that need to be reverted:
${changesDescription}`

  try {
    if (!FUNCTION_APP_URL) throw new Error('AI not configured')

    const fetch = require('node-fetch')
    const aiResponse = await fetch(`${FUNCTION_APP_URL}/aiOperations?operation=recommend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt, userContent }),
      timeout: 30000,
    })

    if (!aiResponse.ok) throw new Error(`AI returned ${aiResponse.status}`)
    const aiText = await aiResponse.text()

    const jsonMatch = aiText.match(/\[[\s\S]*\]/)
    const guide = jsonMatch ? JSON.parse(jsonMatch[0]) : null

    if (guide) {
      res.json({ guide })
      console.log('[POST /manual-guide] ends — steps:', guide.length)
      return
    }
    throw new Error('No JSON in AI response')
  } catch (aiError) {
    console.log('[POST /manual-guide] AI failed, generating fallback:', aiError.message)

    // Fallback: generate basic guide without AI
    const guide = differences.map(d => {
      const field = (d.path || '').split(' → ').pop() || d.path
      const resourceShort = (resourceId || '').split('/').pop() || resourceName
      if (d.type === 'removed') {
        return {
          title: `Restore "${field}"`,
          description: `The property "${field}" was removed. You need to add it back with its original value.`,
          portal: `Azure Portal → Search "${resourceShort}" → Open resource → Settings → Properties → Add "${field}" with value: ${JSON.stringify(d.oldValue)?.slice(0, 40)}`,
          cli: `az resource update --ids "${resourceId}" --set properties.${field}=${JSON.stringify(d.oldValue)?.slice(0, 40)}`,
        }
      }
      if (d.type === 'added') {
        return {
          title: `Remove "${field}"`,
          description: `The property "${field}" was added and should not be there. Remove it to match the baseline.`,
          portal: `Azure Portal → Search "${resourceShort}" → Open resource → Settings → Properties → Remove or reset "${field}"`,
          cli: `az resource update --ids "${resourceId}" --remove properties.${field}`,
        }
      }
      return {
        title: `Revert "${field}" to original value`,
        description: `"${field}" was changed from "${String(d.oldValue ?? '').slice(0, 20)}" to "${String(d.newValue ?? '').slice(0, 20)}". Change it back.`,
        portal: `Azure Portal → Search "${resourceShort}" → Open resource → Settings → Find "${field}" → Change to "${String(d.oldValue ?? '').slice(0, 30)}" → Save`,
        cli: `az resource update --ids "${resourceId}" --set properties.${field}="${String(d.oldValue ?? '').slice(0, 30)}"`,
      }
    })

    res.json({ guide })
    console.log('[POST /manual-guide] ends — fallback steps:', guide.length)
  }
})

module.exports = router
