// ============================================================
// FILE: adip-backend/express-api/src/services/aiOrchestrator.js
// ROLE: Centralized AI orchestration service
//       Single entry point for all OpenAI interactions with:
//       - Circuit breaker protection
//       - Token limits
//       - Response caching
//       - Timeout handling
//       - Retry logic
// ============================================================
'use strict'
const fetch = require('node-fetch')
const { breakers } = require('../shared/circuitBreaker')
const { trackAiCall } = require('../shared/telemetry')

const ENDPOINT   = () => process.env.AZURE_OPENAI_ENDPOINT?.replace(/\/$/, '')
const API_KEY    = () => process.env.AZURE_OPENAI_KEY
const DEPLOYMENT = () => process.env.AZURE_OPENAI_DEPLOYMENT || 'adip-gpt'

// Response cache (5 min TTL)
const _cache = new Map()
const CACHE_TTL = 5 * 60 * 1000

function cacheKey(operation, input) {
  const hash = Buffer.from(JSON.stringify(input).slice(0, 500)).toString('base64url').slice(0, 64)
  return `${operation}:${hash}`
}

/**
 * Core AI call with circuit breaker, timeout, and retry.
 */
async function callAI(system, user, options = {}) {
  const { maxTokens = 600, temperature = 0.3, timeout = 15000, retries = 1 } = options

  if (!ENDPOINT() || !API_KEY()) return null

  const url = `${ENDPOINT()}/openai/deployments/${DEPLOYMENT()}/chat/completions?api-version=2024-10-21`

  return breakers.openai.call(async () => {
    let lastError = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const _aiStart = Date.now()
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeout)

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'api-key': API_KEY() },
          body: JSON.stringify({
            messages: [{ role: 'system', content: system }, { role: 'user', content: user.slice(0, 8000) }],
            max_tokens: maxTokens,
            temperature,
          }),
          signal: controller.signal,
        })
        clearTimeout(timer)

        if (!res.ok) throw new Error(`OpenAI ${res.status}`)
        const data = await res.json()
        trackAiCall({ operation: 'chat', duration: Date.now() - _aiStart, totalTokens: data.usage?.total_tokens, success: true })
        return data.choices[0].message.content
      } catch (e) {
        lastError = e
        if (attempt < retries) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
      }
    }
    throw lastError
  })
}

/**
 * Explain drift in plain English.
 */
async function explainDrift(differences, resourceType) {
  const key = cacheKey('explain', { differences, resourceType })
  const cached = _cache.get(key)
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.value

  const system = 'You explain Azure infrastructure drift concisely. Return 2-4 bullet points explaining what changed and the impact.'
  const user = `Resource type: ${resourceType}\nChanges:\n${differences.map(d => `${d.type}: ${d.path} (${JSON.stringify(d.oldValue)?.slice(0,50)} → ${JSON.stringify(d.newValue)?.slice(0,50)})`).join('\n')}`

  const result = await callAI(system, user, { maxTokens: 300 })
  if (result) _cache.set(key, { value: result, ts: Date.now() })
  return result
}

/**
 * Generate remediation plan.
 */
async function planRemediation(baseline, live, differences) {
  const system = 'You are an Azure remediation planner. Return JSON: {"summary":"","actions":[""],"risks":[""],"safe":true}'
  const user = `Baseline resources: ${(baseline?.resources || []).map(r => r.name + ' (' + (r.type||'').split('/').pop() + ')').join(', ')}\nDifferences: ${differences.length} changes detected\nTop changes: ${differences.slice(0, 5).map(d => d.path).join('; ')}`

  const result = await callAI(system, user, { maxTokens: 400 })
  try { return JSON.parse(result.replace(/```json|```/g, '').trim()) } catch { return { summary: result, actions: [], risks: [], safe: true } }
}

/**
 * Detect anomalies in drift patterns.
 */
async function detectAnomalies(driftStats) {
  if (!driftStats || driftStats.length === 0) return null

  const key = cacheKey('anomaly', driftStats)
  const cached = _cache.get(key)
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.value

  const system = 'Analyze drift patterns for anomalies. Return JSON: {"anomalies":[{"resource":"","issue":"","severity":""}],"summary":""}'
  const user = `Drift stats:\n${driftStats.slice(0, 20).map(s => `${s.name}: ${s.total} drifts, ${s.last24h} in 24h`).join('\n')}`

  const result = await callAI(system, user, { maxTokens: 400 })
  try {
    const parsed = JSON.parse(result.replace(/```json|```/g, '').trim())
    _cache.set(key, { value: parsed, ts: Date.now() })
    return parsed
  } catch { return null }
}

/**
 * Summarize ARM infrastructure (CTO view).
 */
async function summarizeInfrastructure(baseline, live) {
  const system = 'Summarize Azure infrastructure changes. Return JSON: {"summary":"","newResources":[],"deletedResources":[],"modifiedResources":[{"name":"","change":""}],"risks":[{"level":"","description":""}]}'
  const bResources = (baseline?.resources || []).map(r => `${r.name} (${(r.type||'').split('/').pop()})`)
  const lResources = (live?.resources || []).map(r => `${r.name} (${(r.type||'').split('/').pop()})`)
  const user = `Baseline: ${bResources.join(', ')}\nLive: ${lResources.join(', ')}`

  const result = await callAI(system, user, { maxTokens: 600 })
  try { return JSON.parse(result.replace(/```json|```/g, '').trim()) } catch { return null }
}

/**
 * Get circuit breaker status for health checks.
 */
function getHealthStatus() {
  return {
    openai: breakers.openai.getState(),
    cacheSize: _cache.size,
  }
}

module.exports = { callAI, explainDrift, planRemediation, detectAnomalies, summarizeInfrastructure, getHealthStatus }
