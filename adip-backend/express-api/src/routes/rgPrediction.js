'use strict'
// FILE: routes/rgPrediction.js
// ROLE: GET /api/rg-prediction — analyses all resources in a RG, counts drift frequency
//       per resource (24h / 7d / all-time), and calls Azure OpenAI to predict which
//       resources are most likely to drift next.

const router = require('express').Router()
const { ResourceManagementClient } = require('@azure/arm-resources')
const { DefaultAzureCredential }   = require('@azure/identity')
const { TableClient }              = require('@azure/data-tables')
const { BlobServiceClient }        = require('@azure/storage-blob')
const fetch                        = require('node-fetch')

const ENDPOINT   = () => process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, '')
const API_KEY    = () => process.env.AZURE_OPENAI_KEY
const DEPLOYMENT = () => process.env.AZURE_OPENAI_DEPLOYMENT || 'adip-gpt'

async function chatJson(system, user, maxTokens = 800) {
  const url = `${ENDPOINT()}/openai/deployments/${DEPLOYMENT()}/chat/completions?api-version=2024-10-21`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': API_KEY() },
    body: JSON.stringify({
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: maxTokens, temperature: 0.3,
    }),
  })
  if (!res.ok) throw new Error(`OpenAI ${res.status}`)
  const d = await res.json()
  return JSON.parse(d.choices[0].message.content.replace(/```json|```/g, '').trim())
}

// ── GET /api/rg-prediction ────────────────────────────────────────────────────
router.get('/rg-prediction', async (req, res) => {
  console.log('[GET /rg-prediction] starts')
  const { subscriptionId, resourceGroup } = req.query
  if (!subscriptionId || !resourceGroup) {
    return res.status(400).json({ error: 'subscriptionId and resourceGroup required' })
  }

  try {
    // 1. All resources in the RG from ARM
    const cred      = new DefaultAzureCredential()
    const armClient = new ResourceManagementClient(cred, subscriptionId)
    const allResources = []
    for await (const r of armClient.resources.listByResourceGroup(resourceGroup)) {
      allResources.push({ id: r.id, name: r.name, type: r.type, location: r.location })
    }

    // 2. All drift records for this subscription from Table index
    const blobSvc  = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
    const driftCtr = blobSvc.getContainerClient('drift-records')
    const tc       = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'driftIndex')

    const driftRecords = []
    const filter = `PartitionKey eq '${subscriptionId}'`
    for await (const entity of tc.listEntities({ queryOptions: { filter } })) {
      const doc = await driftCtr.getBlobClient(entity.blobKey)
        .downloadToBuffer().then(b => JSON.parse(b)).catch(() => null)
      if (doc) driftRecords.push(doc)
    }

    // 3. Build per-resource frequency stats
    const now = Date.now()
    const statsMap = {}

    // Seed every known resource with zero counts
    allResources.forEach(r => {
      statsMap[r.name] = {
        name: r.name, resourceId: r.id, type: r.type,
        total: 0, last24h: 0, last7d: 0,
        severities: { critical: 0, high: 0, medium: 0, low: 0 },
        topFields: {},
        lastDriftAt: null,
        driftDates: [],   // ISO date strings for timeline
      }
    })

    // Accumulate drift records (may include resources from other RGs)
    driftRecords.forEach(r => {
      const name = r.resourceId?.split('/').pop()
      if (!name) return
      if (!statsMap[name]) {
        statsMap[name] = {
          name, resourceId: r.resourceId, type: r.resourceId?.split('/')[7] || 'unknown',
          total: 0, last24h: 0, last7d: 0,
          severities: { critical: 0, high: 0, medium: 0, low: 0 },
          topFields: {}, lastDriftAt: null, driftDates: [],
        }
      }
      const s   = statsMap[name]
      const ageH = (now - new Date(r.detectedAt)) / 3600000
      s.total++
      if (ageH <= 24)  s.last24h++
      if (ageH <= 168) s.last7d++
      if (r.severity && s.severities[r.severity] !== undefined) s.severities[r.severity]++
      if (!s.lastDriftAt || r.detectedAt > s.lastDriftAt) s.lastDriftAt = r.detectedAt
      s.driftDates.push(r.detectedAt?.slice(0, 10))
      ;(r.differences || r.changes || []).forEach(d => {
        const field = (d.path || '').split(' → ')[0] || 'unknown'
        s.topFields[field] = (s.topFields[field] || 0) + 1
      })
    })

    // Convert topFields map to sorted array
    const resourceStats = Object.values(statsMap).map(s => ({
      ...s,
      topFields: Object.entries(s.topFields).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([field, count]) => ({ field, count })),
      riskScore: s.last24h * 10 + s.last7d * 3 + s.total,  // simple frequency-weighted score
    })).sort((a, b) => b.riskScore - a.riskScore)

    // 4. AI prediction — only if there's drift history
    let aiPredictions = []
    const driftedResources = resourceStats.filter(r => r.total > 0)
    if (driftedResources.length > 0 && ENDPOINT() && API_KEY()) {
      const summary = driftedResources.map(r => ({
        name:      r.name,
        type:      r.type?.split('/').pop(),
        total:     r.total,
        last24h:   r.last24h,
        last7d:    r.last7d,
        severities: r.severities,
        topFields: r.topFields.map(f => f.field),
        lastDrift: r.lastDriftAt,
      }))

      aiPredictions = await chatJson(
        `You are an Azure infrastructure risk analyst. Analyse drift frequency patterns across resources in a resource group and predict which are most likely to drift in the next 7 days.
Respond ONLY with valid JSON array (no markdown), max 5 items, sorted by risk descending:
[{"resourceName":"name","likelihood":"HIGH|MEDIUM|LOW","predictedDays":1-7,"reason":"1-2 sentences based on frequency and recency","fieldsAtRisk":["field1"]}]`,
        `Resource group drift history:\n${JSON.stringify(summary)}`,
        800
      ).catch(() => [])
    }

    res.json({ resourceStats, aiPredictions, totalResources: allResources.length, totalDriftEvents: driftRecords.length })
    console.log('[GET /rg-prediction] ends — resources:', allResources.length, 'drifts:', driftRecords.length)
  } catch (err) {
    console.error('[GET /rg-prediction] error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
