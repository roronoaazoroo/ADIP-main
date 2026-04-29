// ============================================================
// FILE: adip-backend/express-api/src/routes/dependencyGraph.js
// ROLE: HTTP endpoint for resource dependency graph
//
// GET /api/dependency-graph?subscriptionId=&resourceGroupId=
//   Returns { nodes[], links[] } for react-force-graph-2d
//   Cached 5 minutes per subscription+RG pair
// ============================================================
'use strict'
const router = require('express').Router()
const { buildDependencyGraph } = require('../services/dependencyGraphService')

const CACHE_TTL_MS = 5 * 60 * 1000
const _cache = new Map()

router.get('/dependency-graph', async (req, res) => {
  console.log('[GET /dependency-graph] starts')
  const { subscriptionId, resourceGroupId } = req.query

  if (!subscriptionId || !resourceGroupId) {
    return res.status(400).json({ error: 'subscriptionId and resourceGroupId required' })
  }

  const cacheKey = `${subscriptionId}|${resourceGroupId}`
  const cached   = _cache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    console.log('[GET /dependency-graph] ends — cache hit')
    return res.json(cached.data)
  }

  try {
    const graph = await buildDependencyGraph(subscriptionId, resourceGroupId)
    _cache.set(cacheKey, { data: graph, expiresAt: Date.now() + CACHE_TTL_MS })
    res.json(graph)
    console.log('[GET /dependency-graph] ends — nodes:', graph.nodes.length, 'links:', graph.links.length)
  } catch (err) {
    console.log('[GET /dependency-graph] ends — error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
