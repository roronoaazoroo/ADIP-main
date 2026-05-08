// FILE: routes/rgPrediction.js
// ROLE: GET /api/rg-prediction — analyses drift frequency per resource using Table Storage
//       (no blob downloads). Calls OpenAI only for prediction summary.
'use strict'
const router = require('express').Router()
const { TableClient } = require('@azure/data-tables')
const { getArmClient } = require('../shared/armCache')
const { odataEscape } = require('../shared/sanitize')
const fetch = require('node-fetch')

const ENDPOINT   = () => process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, '')
const API_KEY    = () => process.env.AZURE_OPENAI_KEY
const DEPLOYMENT = () => process.env.AZURE_OPENAI_DEPLOYMENT || 'adip-gpt'

// Cache predictions for 5 minutes
const _cache = new Map()
const CACHE_TTL = 5 * 60 * 1000

router.get('/rg-prediction', async (req, res) => {
  const { subscriptionId, resourceGroup } = req.query
  if (!subscriptionId || !resourceGroup) {
    return res.status(400).json({ error: 'subscriptionId and resourceGroup required' })
  }

  // Check cache
  const cacheKey = `${subscriptionId}|${resourceGroup}`
  const cached = _cache.get(cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TTL) return res.json(cached.data)

  try {
    // 1. List resources from ARM (uses shared cached client)
    const armClient = getArmClient(subscriptionId)
    const allResources = []
    for await (const r of armClient.resources.listByResourceGroup(resourceGroup)) {
      allResources.push({ id: r.id, name: r.name, type: r.type, location: r.location })
    }

    // 2. Aggregate from driftIndex TABLE (no blob downloads!)
    const tc = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'driftIndex')
    const filter = `PartitionKey eq '${odataEscape(subscriptionId)}'`
    
    const now = Date.now()
    const statsMap = {}
    allResources.forEach(r => {
      statsMap[r.name] = {
        name: r.name, resourceId: r.id, type: r.type,
        total: 0, last24h: 0, last7d: 0,
        severities: { critical: 0, high: 0, medium: 0, low: 0 },
        lastDriftAt: null,
      }
    })

    // Iterate table entities (lightweight — no blob reads)
    for await (const entity of tc.listEntities({ queryOptions: { filter } })) {
      const resourceName = (entity.resourceId || '').split('/').pop()
      if (!resourceName || !statsMap[resourceName]) continue
      
      const s = statsMap[resourceName]
      s.total++
      const ts = new Date(entity.timestamp || entity.detectedAt || 0).getTime()
      if (now - ts < 24 * 60 * 60 * 1000) s.last24h++
      if (now - ts < 7 * 24 * 60 * 60 * 1000) s.last7d++
      const sev = (entity.severity || 'low').toLowerCase()
      if (s.severities[sev] !== undefined) s.severities[sev]++
      if (!s.lastDriftAt || ts > new Date(s.lastDriftAt).getTime()) s.lastDriftAt = entity.timestamp || entity.detectedAt
    }

    // 3. Sort by drift frequency
    const sorted = Object.values(statsMap).sort((a, b) => b.total - a.total)
    const topDrifters = sorted.filter(s => s.total > 0).slice(0, 10)

    // 4. AI prediction (only if there's drift data, skip otherwise)
    let prediction = null
    if (topDrifters.length > 0 && ENDPOINT() && API_KEY()) {
      try {
        const summary = topDrifters.map(s => `${s.name} (${s.type?.split('/').pop()}): ${s.total} total, ${s.last24h} last 24h, ${s.last7d} last 7d`).join('\n')
        const url = `${ENDPOINT()}/openai/deployments/${DEPLOYMENT()}/chat/completions?api-version=2024-10-21`
        const aiRes = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'api-key': API_KEY() },
          body: JSON.stringify({
            messages: [
              { role: 'system', content: 'You predict Azure infrastructure drift. Return JSON: {"predictions":[{"resource":"name","risk":"high|medium|low","reason":"brief"}],"summary":"one sentence"}' },
              { role: 'user', content: `RG: ${resourceGroup}\nDrift stats:\n${summary}` }
            ],
            max_tokens: 400, temperature: 0.3,
          }),
        })
        if (aiRes.ok) {
          const d = await aiRes.json()
          prediction = JSON.parse(d.choices[0].message.content.replace(/```json|```/g, '').trim())
        }
      } catch { /* AI prediction is non-critical */ }
    }

    const result = { resources: sorted, topDrifters, prediction, resourceCount: allResources.length }
    _cache.set(cacheKey, { data: result, ts: Date.now() })
    res.json(result)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

module.exports = router
