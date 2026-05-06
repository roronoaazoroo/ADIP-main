'use strict'
// FILE: routes/driftRiskTimeline.js
// ROLE: GET /api/drift-risk-timeline
//   Fast path: reads only driftIndex Table (no blob fetches) + ARM resource list (cached 5min).
//   Severity weights: critical=100, high=70, medium=40, low=15

const router = require('express').Router()
const { ResourceManagementClient } = require('@azure/arm-resources')
const { DefaultAzureCredential }   = require('@azure/identity')
const { TableClient }              = require('@azure/data-tables')

const SEV_WEIGHT = { critical: 100, high: 70, medium: 40, low: 15 }

//  ARM resource name cache (5-minute TTL) 
const _armCache = new Map()  // key: `${subscriptionId}:${resourceGroup}` → { names: Set, expiresAt }

async function getExistingNames(subscriptionId, resourceGroup) {
  const key = `${subscriptionId}:${resourceGroup || ''}`
  const cached = _armCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.names

  const cred   = new DefaultAzureCredential()
  const client = new ResourceManagementClient(cred, subscriptionId)
  const names  = new Set()

  const iter = resourceGroup
    ? client.resources.listByResourceGroup(resourceGroup)
    : client.resources.list()

  for await (const r of iter) names.add(r.name.toLowerCase())

  _armCache.set(key, { names, expiresAt: Date.now() + 5 * 60 * 1000 })
  return names
}

//  Read index rows only — no blob fetches 
async function getDriftIndexRows(subscriptionId, resourceGroup, since) {
  const tc = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'driftIndex')
  let filter = `PartitionKey eq '${subscriptionId}'`
  if (resourceGroup) filter += ` and resourceGroup eq '${resourceGroup}'`
  if (since)         filter += ` and detectedAt ge '${since}'`

  const rows = []
  // Select only the fields we need — avoids transferring full entity payload
  for await (const e of tc.listEntities({ queryOptions: { filter, select: ['resourceId','severity','detectedAt','resourceGroup'] } })) {
    rows.push(e)
  }
  return rows
}

router.get('/drift-risk-timeline', async (req, res) => {
  console.log('[GET /drift-risk-timeline] starts')
  const { subscriptionId, resourceGroup, days: daysParam = '30' } = req.query
  if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' })

  const DAYS  = daysParam === '7' ? 7 : 30
  const since = new Date(Date.now() - DAYS * 86400000).toISOString()

  try {
    // Run ARM list + Table index query in parallel
    const [existingNames, rows] = await Promise.all([
      getExistingNames(subscriptionId, resourceGroup),
      getDriftIndexRows(subscriptionId, resourceGroup, since),
    ])

    // Build date axis
    const dates = Array.from({ length: DAYS }, (_, i) => {
      const d = new Date(Date.now() - (DAYS - 1 - i) * 86400000)
      return d.toISOString().slice(0, 10)
    })

    // Aggregate per-resource per-day scores — index rows only, no blob reads
    const resourceMap = {}

    rows.forEach(r => {
      const name = r.resourceId?.split('/').pop()
      if (!name || !existingNames.has(name.toLowerCase())) return

      if (!resourceMap[name]) {
        resourceMap[name] = {
          name,
          resourceId:  r.resourceId,
          type:        r.resourceId?.split('/')[7] || 'unknown',
          dailyScores: {},
          severities:  { critical: 0, high: 0, medium: 0, low: 0 },
          totalDrifts: 0,
          lastDrift:   null,
        }
      }

      const s   = resourceMap[name]
      const day = r.detectedAt?.slice(0, 10)
      if (day) s.dailyScores[day] = (s.dailyScores[day] || 0) + (SEV_WEIGHT[r.severity] || 15)
      if (r.severity && s.severities[r.severity] !== undefined) s.severities[r.severity]++
      if (!s.lastDrift || r.detectedAt > s.lastDrift) s.lastDrift = r.detectedAt
      s.totalDrifts++
    })

    const series = Object.values(resourceMap)
      .map(r => ({
        name:        r.name,
        type:        r.type,
        resourceId:  r.resourceId,
        scores:      dates.map(d => r.dailyScores[d] || 0),
        totalDrifts: r.totalDrifts,
        severities:  r.severities,
        lastDrift:   r.lastDrift,
        peakScore:   Math.max(...Object.values(r.dailyScores), 0),
        topFields:   [],  // not available from index — omit to keep fast path clean
      }))
      .sort((a, b) => b.peakScore - a.peakScore)
      .slice(0, 10)

    res.json({ dates, series })
    console.log('[GET /drift-risk-timeline] ends — series:', series.length, 'rows scanned:', rows.length)
  } catch (err) {
    console.error('[GET /drift-risk-timeline] error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
