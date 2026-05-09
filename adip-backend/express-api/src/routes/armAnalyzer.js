// ============================================================
// FILE: adip-backend/express-api/src/routes/armAnalyzer.js
// ROLE: Full ARM Context Drift Analyzer — CTO-only endpoint
//
// POST /api/arm-analyze
//   Body: { subscriptionId, resourceGroupId, baselineState, liveState, differences }
//   Returns: { summary, newResources[], deletedResources[], modifiedResources[], risks[] }
// ============================================================
'use strict'
const router = require('express').Router()
const jwt = require('jsonwebtoken')
const JWT_SECRET = process.env.JWT_SECRET || 'adip-dev-secret-change-in-production'

// Strip noisy fields before sending to AI
function cleanForAI(obj) {
  if (!obj) return null
  const NOISE = ['provisioningState', 'etag', 'changedTime', 'createdTime', 'lastModifiedAt', 'systemData', '_ts', '_etag', '_rid', '_self', '_childConfig', 'managedBy', 'resourceGuid', 'timeCreated', 'instanceView']
  const strip = (o) => {
    if (Array.isArray(o)) return o.map(strip)
    if (o && typeof o === 'object') return Object.fromEntries(
      Object.entries(o).filter(([k]) => !NOISE.includes(k)).map(([k, v]) => [k, strip(v)])
    )
    return o
  }
  return strip(obj)
}

router.post('/arm-analyze', async (req, res) => {
  console.log('[POST /arm-analyze] starts')

  // Role check — CTO/admin only
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const user = jwt.verify(authHeader.slice(7), JWT_SECRET)
      if (user.role === 'requestor') return res.status(403).json({ error: 'CTO/Admin access only' })
    } catch {}
  }

  const { subscriptionId, resourceGroupId, baselineState, liveState, differences } = req.body
  if (!baselineState && !liveState) return res.status(400).json({ error: 'baselineState or liveState required' })

  const endpoint = process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, '')
  const apiKey = process.env.AZURE_OPENAI_KEY
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'adip-gpt'
  if (!endpoint || !apiKey) return res.status(500).json({ error: 'OpenAI not configured' })

  // Summarize ARM intelligently — list all resources with key properties
  function summarizeArm(state) {
    if (!state) return 'null'
    const resources = state.resources || (state.name ? [state] : [])
    if (!resources.length) return JSON.stringify(cleanForAI(state), null, 1).slice(0, 2000)
    return resources.map(r => {
      const props = r.properties || {}
      return `Resource: ${r.name} (${r.type})\n  Location: ${r.location}\n  SKU: ${JSON.stringify(r.sku) || 'none'}\n  Kind: ${r.kind || 'none'}\n  Tags: ${JSON.stringify(r.tags) || '{}'}\n  Key Properties: ${Object.entries(props).slice(0, 10).map(([k,v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v).slice(0,50) : v}`).join(', ')}`
    }).join('\n\n')
  }
  const cleanBaseline = summarizeArm(cleanForAI(baselineState))
  const cleanLive = summarizeArm(cleanForAI(liveState))
  // Filter out volatile/noise fields before sending to AI
  const NOISE = ['defaultSecurityRules', 'osProfile', 'vmId', 'resourceGuid', 'provisioningState', 'macAddress', 'ipAddress', 'dnsSettings', 'uniqueId', 'creationData', 'timeCreated', 'primary', 'virtualMachine', 'networkInterfaces', 'subnets']
  const meaningfulDiffs = (differences || []).filter(d => !NOISE.some(n => (d.path || '').includes(n)))
  const diffSummary = meaningfulDiffs.slice(0, 15).map(d => `${d.type} ${d.path}: ${JSON.stringify(d.oldValue)?.slice(0,20)} → ${JSON.stringify(d.newValue)?.slice(0,20)}`).join('\n')

  const systemPrompt = `You are an Azure infrastructure drift analysis engine.
Compare baseline and live ARM templates directly. Do not rely only on provided diffs.

Rules:
- List EVERY newly added resource: "New [resource type] created: [resource name]" — do not skip any
- List EVERY deleted resource: "[resource name] was deleted"
- For modified resources: only mention MEANINGFUL changes (skip volatile fields like vmId, osProfile, defaultSecurityRules, macAddress, provisioningState)
- If no meaningful modifications exist, say "No significant configuration changes detected"
- Infer dependent Azure resources created together (VM → NIC, IP, NSG, Disk)
- Be concise but infrastructure-aware
- Group related resources logically

Return ONLY valid JSON with this exact schema:
{
  "summary": "one sentence overall summary",
  "newResources": [{"name": "", "type": "", "description": ""}],
  "deletedResources": [{"name": "", "type": "", "description": ""}],
  "modifiedResources": [{"name": "", "field": "", "from": "", "to": "", "impact": ""}],
  "risks": [{"level": "critical|high|medium|low", "description": ""}]
}
No markdown, no explanation outside the JSON.`

  const userContent = `Resource Group: ${resourceGroupId || 'unknown'}
Subscription: ${subscriptionId || ''}

BASELINE ARM (approved golden state):
${cleanBaseline}

LIVE ARM (current state):
${cleanLive}

STRUCTURED DIFFS:
${diffSummary || 'none provided'}`

  try {
    const fetch = require('node-fetch')
    const aiRes = await fetch(`${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2024-02-15-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
      body: JSON.stringify({
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userContent }],
        max_tokens: 1500, temperature: 0.2,
      }),
    })
    if (!aiRes.ok) throw new Error(`OpenAI ${aiRes.status}`)
    const data = await aiRes.json()
    const content = data.choices[0]?.message?.content?.trim() || ''

    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const analysis = JSON.parse(jsonMatch[0])
      res.json(analysis)
    } else {
      res.json({ summary: content, newResources: [], deletedResources: [], modifiedResources: [], risks: [] })
    }
    console.log('[POST /arm-analyze] ends')
  } catch (error) {
    console.log('[POST /arm-analyze] error:', error.message)
    // Fallback: generate basic analysis without AI
    const baseResources = baselineState?.resources || (baselineState?.name ? [baselineState] : [])
    const liveResources = liveState?.resources || (liveState?.name ? [liveState] : [])
    const baseNames = new Set(baseResources.map(r => r.name?.toLowerCase()))
    const liveNames = new Set(liveResources.map(r => r.name?.toLowerCase()))

    const newResources = liveResources.filter(r => !baseNames.has(r.name?.toLowerCase())).map(r => ({ name: r.name, type: (r.type || '').split('/').pop(), description: `New ${(r.type || '').split('/').pop()} in ${r.location || 'unknown region'}` }))
    const deletedResources = baseResources.filter(r => !liveNames.has(r.name?.toLowerCase())).map(r => ({ name: r.name, type: (r.type || '').split('/').pop(), description: `${r.name} no longer exists` }))

    res.json({
      summary: `${newResources.length} new, ${deletedResources.length} deleted, ${(differences || []).length} modifications`,
      newResources, deletedResources,
      modifiedResources: meaningfulDiffs.slice(0, 10).map(d => ({ name: d.path?.split(' → ')[0] || '', field: d.path, from: String(d.oldValue ?? '').slice(0, 30), to: String(d.newValue ?? '').slice(0, 30), impact: d.type })),
      risks: [],
    })
  }
})

module.exports = router
