'use strict'
// FILE: routes/rgPrediction.js
// ROLE: GET /api/rg-prediction — learns from past drift + user activity to predict future drift
const router = require('express').Router()
const { TableClient } = require('@azure/data-tables')
const { getArmClient } = require('../shared/armCache')
const { odataEscape } = require('../shared/sanitize')
const fetch = require('node-fetch')

const ENDPOINT   = () => process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, '')
const API_KEY    = () => process.env.AZURE_OPENAI_KEY
const DEPLOYMENT = () => process.env.AZURE_OPENAI_DEPLOYMENT || 'adip-gpt'

const _cache = new Map()
const CACHE_TTL = 5 * 60 * 1000

// ── Linear Regression (predicts trend) ────────────────────────────────────────
function linearRegression(points) {
  const n = points.length
  if (n < 2) return { slope: 0, intercept: 0, r2: 0 }
  const sumX = points.reduce((s, p) => s + p.x, 0)
  const sumY = points.reduce((s, p) => s + p.y, 0)
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0)
  const sumX2 = points.reduce((s, p) => s + p.x * p.x, 0)
  const denom = n * sumX2 - sumX * sumX
  if (denom === 0) return { slope: 0, intercept: sumY / n, r2: 0 }
  const slope = (n * sumXY - sumX * sumY) / denom
  const intercept = (sumY - slope * sumX) / n
  // R² (confidence)
  const meanY = sumY / n
  const ssRes = points.reduce((s, p) => s + Math.pow(p.y - (slope * p.x + intercept), 2), 0)
  const ssTot = points.reduce((s, p) => s + Math.pow(p.y - meanY, 2), 0)
  const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot)
  return { slope, intercept, r2 }
}

// ── Compute drift probability from frequency features ─────────────────────────
function computeDriftProbability(stat, now) {
  const { total, last24h, last7d, lastDriftAt, driftDates = [] } = stat
  if (total === 0) return { probability: 0, trend: 'stable', nextDriftInDays: null, confidence: 0 }

  // Build daily time series (last 30 days)
  const dailyCounts = {}
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now - i * 86400000).toISOString().slice(0, 10)
    dailyCounts[d] = 0
  }
  driftDates.forEach(d => { if (dailyCounts[d] !== undefined) dailyCounts[d]++ })
  const points = Object.values(dailyCounts).map((y, x) => ({ x, y }))

  // Linear regression on daily counts
  const { slope, r2 } = linearRegression(points)

  // Average interval between drifts
  const daysSinceLast = lastDriftAt ? Math.max(0, (now - new Date(lastDriftAt).getTime()) / 86400000) : 999
  const avgInterval = total > 1 ? 30 / total : 30 // avg days between drifts in last 30 days

  // Predicted next drift
  const nextDriftInDays = Math.max(0, Math.round(avgInterval - daysSinceLast))

  // Probability formula (0-100)
  const recencyScore = daysSinceLast < 1 ? 40 : daysSinceLast < 3 ? 25 : daysSinceLast < 7 ? 15 : 5
  const frequencyScore = Math.min(35, (last7d / 7) * 35)
  const trendScore = slope > 0 ? Math.min(25, slope * 25) : 0
  const probability = Math.min(100, Math.round(recencyScore + frequencyScore + trendScore))

  const trend = slope > 0.2 ? 'accelerating' : slope < -0.2 ? 'decelerating' : 'stable'

  return { probability, trend, nextDriftInDays, confidence: Math.round(r2 * 100), slope: Math.round(slope * 100) / 100 }
}

router.get('/rg-prediction', async (req, res) => {
  const { subscriptionId, resourceGroup } = req.query
  if (!subscriptionId) {
    return res.status(400).json({ error: 'subscriptionId required' })
  }

  const cacheKey = `${subscriptionId}|${resourceGroup}`
  const cached = _cache.get(cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TTL) return res.json(cached.data)

  try {
    const armClient = getArmClient(subscriptionId)
    const allResources = []
    if (resourceGroup) {
      for await (const r of armClient.resources.listByResourceGroup(resourceGroup)) {
        allResources.push({ id: r.id, name: r.name, type: r.type, location: r.location })
      }
    } else {
      // No RG specified — get all resources from driftIndex (no ARM call needed)
    }

    // Aggregate from driftIndex + changesIndex
    const driftTc = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'driftIndex')
    const changesTc = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'changesIndex')
    const filter = `PartitionKey eq '${odataEscape(subscriptionId)}'`

    const now = Date.now()
    const statsMap = {}
    allResources.forEach(r => {
      statsMap[r.name] = {
        name: r.name, resourceId: r.id, type: r.type,
        total: 0, last24h: 0, last7d: 0,
        severities: { critical: 0, high: 0, medium: 0, low: 0 },
        lastDriftAt: null, driftDates: [],
        callers: {},  // who causes drift on this resource
        hourDistribution: new Array(24).fill(0), // what hours drift happens
        dayDistribution: new Array(7).fill(0),   // what days drift happens
      }
    })

    // Drift history
    for await (const entity of driftTc.listEntities({ queryOptions: { filter } })) {
      const resourceName = (entity.resourceId || '').split('/').pop()
      if (!resourceName) continue
      // Auto-create entry for resources not in ARM list (when no RG filter)
      if (!statsMap[resourceName]) {
        if (resourceGroup) continue  // skip if RG-scoped and resource not in RG
        statsMap[resourceName] = {
          name: resourceName, resourceId: entity.resourceId || '', type: (entity.resourceId || '').split('/').slice(6,8).join('/'),
          total: 0, last24h: 0, last7d: 0,
          severities: { critical: 0, high: 0, medium: 0, low: 0 },
          lastDriftAt: null, driftDates: [],
          callers: {}, hourDistribution: new Array(24).fill(0), dayDistribution: new Array(7).fill(0),
        }
      }
      const s = statsMap[resourceName]
      s.total++
      const detectedAt = entity.detectedAt || entity.timestamp || ''
      const ts = new Date(detectedAt).getTime()
      if (now - ts < 86400000) s.last24h++
      if (now - ts < 7 * 86400000) s.last7d++
      const sev = (entity.severity || 'low').toLowerCase()
      if (s.severities[sev] !== undefined) s.severities[sev]++
      if (!s.lastDriftAt || ts > new Date(s.lastDriftAt).getTime()) s.lastDriftAt = detectedAt
      const dateStr = detectedAt.slice(0, 10)
      if (dateStr) s.driftDates.push(dateStr)
      // Hour and day distribution
      const dt = new Date(detectedAt)
      if (!isNaN(dt)) {
        s.hourDistribution[dt.getUTCHours()]++
        s.dayDistribution[dt.getUTCDay()]++
      }
      // Caller tracking
      const caller = entity.caller || ''
      if (caller && caller !== 'System') s.callers[caller] = (s.callers[caller] || 0) + 1
    }

    // User activity from changesIndex (who is active recently)
    const userActivity = {} // caller → { totalChanges, last24h, resources: Set }
    for await (const entity of changesTc.listEntities({ queryOptions: { filter } })) {
      const caller = entity.caller?.trim()
      if (!caller || caller === 'System' || caller.startsWith('Azure ')) continue
      if (!userActivity[caller]) userActivity[caller] = { totalChanges: 0, last24h: 0, resources: new Set() }
      userActivity[caller].totalChanges++
      const ts = new Date(entity.detectedAt || entity.timestamp || 0).getTime()
      if (now - ts < 86400000) userActivity[caller].last24h++
      const resName = (entity.resourceId || '').split('/').pop()
      if (resName) userActivity[caller].resources.add(resName)
    }

    // Compute predictions per resource
    const sorted = Object.values(statsMap).map(s => {
      const pred = computeDriftProbability(s, now)
      // Top caller for this resource
      const topCaller = Object.entries(s.callers).sort((a, b) => b[1] - a[1])[0]
      // Peak hour and day
      const peakHour = s.hourDistribution.indexOf(Math.max(...s.hourDistribution))
      const peakDay = s.dayDistribution.indexOf(Math.max(...s.dayDistribution))
      const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      return {
        ...s,
        prediction: pred,
        topCaller: topCaller ? { name: topCaller[0], count: topCaller[1] } : null,
        peakHour: s.total > 0 ? `${peakHour}:00 UTC` : null,
        peakDay: s.total > 0 ? dayNames[peakDay] : null,
        // Clean up internal fields
        callers: undefined, hourDistribution: undefined, dayDistribution: undefined,
      }
    }).sort((a, b) => (b.prediction?.probability || 0) - (a.prediction?.probability || 0))

    const topDrifters = sorted.filter(s => s.total > 0).slice(0, 10)

    // Active users who are likely to cause drift soon
    const activeUsers = Object.entries(userActivity)
      .map(([caller, data]) => ({
        caller,
        totalChanges: data.totalChanges,
        last24h: data.last24h,
        resourcesAffected: [...data.resources].slice(0, 5),
        riskLevel: data.last24h >= 3 ? 'HIGH' : data.last24h >= 1 ? 'MEDIUM' : 'LOW',
      }))
      .filter(u => u.last24h > 0)
      .sort((a, b) => b.last24h - a.last24h)
      .slice(0, 5)

    // AI prediction with full context
    let aiPredictions = []
    if (topDrifters.length > 0 && ENDPOINT() && API_KEY()) {
      try {
        const context = topDrifters.map(s => ({
          resource: s.name,
          type: s.type?.split('/').pop(),
          total: s.total,
          last24h: s.last24h,
          last7d: s.last7d,
          trend: s.prediction?.trend,
          probability: s.prediction?.probability,
          nextDriftInDays: s.prediction?.nextDriftInDays,
          topCaller: s.topCaller?.name,
          peakHour: s.peakHour,
          peakDay: s.peakDay,
        }))
        const activeUsersSummary = activeUsers.map(u => `${u.caller}: ${u.last24h} changes today on [${u.resourcesAffected.join(', ')}]`)

        const url = `${ENDPOINT()}/openai/deployments/${DEPLOYMENT()}/chat/completions?api-version=2024-10-21`
        const aiRes = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'api-key': API_KEY() },
          body: JSON.stringify({
            messages: [
              { role: 'system', content: `You predict Azure infrastructure drift based on historical patterns and user activity.
Analyze the drift frequency, user behavior patterns, peak times, and trends.
Return JSON array (max 5 items, sorted by probability desc):
[{"resourceName":"name","likelihood":"HIGH|MEDIUM|LOW","driftProbability":<0-100>,"predictedDays":<1-7>,"reason":"2 sentences explaining WHY based on user patterns and frequency","fieldsAtRisk":["field1"],"predictedCaller":"who will likely cause it","predictedTimeWindow":"e.g. Monday 9-11 AM UTC"}]
Rules: probability >= 70 = HIGH, 40-69 = MEDIUM, < 40 = LOW.
Base predictions on: drift acceleration/deceleration trends, user activity patterns, time-of-day patterns, day-of-week patterns.` },
              { role: 'user', content: `Resource Group: ${resourceGroup}
Drift history per resource:\n${JSON.stringify(context, null, 1)}
\nActive users (last 24h):\n${activeUsersSummary.join('\n') || 'No recent user activity'}` }
            ],
            max_tokens: 600, temperature: 0.3,
          }),
        })
        if (aiRes.ok) {
          const d = await aiRes.json()
          const parsed = JSON.parse(d.choices[0].message.content.replace(/```json|```/g, '').trim())
          aiPredictions = Array.isArray(parsed) ? parsed : []
        }
      } catch (aiErr) {
        console.log('[rg-prediction] AI error (non-fatal):', aiErr.message)
      }
    }

    const totalDriftEvents = sorted.reduce((sum, r) => sum + r.total, 0)
    const result = {
      resourceStats: sorted,
      aiPredictions,
      totalResources: allResources.length,
      totalDriftEvents,
      activeUsers,
      topDrifters,
    }
    _cache.set(cacheKey, { data: result, ts: Date.now() })
    res.json(result)
  } catch (error) {
    console.log('[rg-prediction] error:', error.message)
    res.status(500).json({ error: error.message })
  }
})

module.exports = router
