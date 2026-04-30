// FILE: test_prediction_e2e.cjs
// ROLE: End-to-end test for Drift Prediction & Forecasting feature
//
// Flow tested:
//   1. driftIndex Table — verify drift records exist (data source)
//   2. GET /api/drift-risk-timeline?days=7  — bubble chart data (fast path, no blob reads)
//   3. GET /api/drift-risk-timeline?days=30 — 30-day window
//   4. GET /api/ai/predict                  — per-resource AI prediction (via Express → Function)
//   5. GET /api/ai/rg-recommendations       — RG-level AI recommendations
//   6. GET /api/rg-prediction               — RG bubble matrix + AI predictions

'use strict'
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') })

const fetch      = require('node-fetch')
const { TableClient } = require('@azure/data-tables')

const SUB      = process.env.AZURE_SUBSCRIPTION_ID
const RG       = process.env.AZURE_RESOURCE_GROUP || 'rg-adip'
const API      = 'http://localhost:3001/api'

let passed = 0, failed = 0

function assert(cond, label, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++ }
  else       { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failed++ }
}

// ── 1. Verify drift records exist in Table Storage ────────────────────────────
async function testDriftIndexHasRecords() {
  console.log('\n[1] driftIndex Table — verify drift records exist')
  const tc = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'driftIndex')
  let count = 0, sample = null
  for await (const e of tc.listEntities({ queryOptions: { filter: `PartitionKey eq '${SUB}'`, select: ['resourceId','severity','detectedAt','resourceGroup'] } })) {
    if (!sample) sample = e
    if (++count >= 5) break
  }
  assert(count > 0, `driftIndex has records for subscription`, `found ${count}`)
  if (sample) {
    assert(!!sample.resourceId,  'record has resourceId')
    assert(!!sample.severity,    'record has severity')
    assert(!!sample.detectedAt,  'record has detectedAt')
    console.log(`    Sample: ${sample.resourceId?.split('/').pop()} | ${sample.severity} | ${sample.detectedAt?.slice(0,10)}`)
  }
  return sample
}

// ── 2 & 3. GET /api/drift-risk-timeline ──────────────────────────────────────
async function testDriftRiskTimeline(days) {
  console.log(`\n[${days === 7 ? 2 : 3}] GET /api/drift-risk-timeline?days=${days}`)
  const start = Date.now()
  const res   = await fetch(`${API}/drift-risk-timeline?subscriptionId=${SUB}&resourceGroup=${RG}&days=${days}`)
  const ms    = Date.now() - start
  assert(res.ok, `HTTP 200`, `got ${res.status}`)
  const data = await res.json()
  assert(Array.isArray(data.dates),  'response has dates[]')
  assert(Array.isArray(data.series), 'response has series[]')
  assert(data.dates.length === days, `dates.length === ${days}`, `got ${data.dates.length}`)
  console.log(`    Response time: ${ms}ms | series: ${data.series.length} resources`)
  if (data.series.length > 0) {
    const s = data.series[0]
    assert(typeof s.name        === 'string',  'series[0] has name')
    assert(Array.isArray(s.scores),            'series[0] has scores[]')
    assert(s.scores.length === days,           `scores.length === ${days}`)
    assert(typeof s.totalDrifts === 'number',  'series[0] has totalDrifts')
    assert(typeof s.peakScore   === 'number',  'series[0] has peakScore')
    assert(s.peakScore >= 0, 'peakScore is non-negative', `got ${s.peakScore}`)
    console.log(`    Top resource: ${s.name} | totalDrifts: ${s.totalDrifts} | peakScore: ${s.peakScore}`)
  }
  assert(ms < 10000, `response under 10s`, `took ${ms}ms`)
  return data
}

// ── 4. GET /api/ai/predict ────────────────────────────────────────────────────
async function testAiPredict(resourceId) {
  console.log('\n[4] GET /api/ai/predict — per-resource AI prediction')
  if (!resourceId) { console.log('    SKIP — no resourceId (no drift records found)'); return }
  const res  = await fetch(`${API}/ai/predict?subscriptionId=${SUB}&resourceId=${encodeURIComponent(resourceId)}`)
  assert(res.ok, `HTTP 200`, `got ${res.status}`)
  const data = await res.json()
  assert(['HIGH','MEDIUM','LOW'].includes(data.likelihood),          'likelihood is HIGH/MEDIUM/LOW', data.likelihood)
  assert(typeof data.driftProbability === 'number',                  'driftProbability is a number')
  assert(data.driftProbability >= 0 && data.driftProbability <= 100, 'driftProbability in 0-100', `got ${data.driftProbability}`)
  assert(typeof data.reasoning === 'string' && data.reasoning.length > 10, 'reasoning is non-empty string')
  assert(Array.isArray(data.fieldsAtRisk),                           'fieldsAtRisk is array')
  console.log(`    Resource : ${resourceId.split('/').pop()}`)
  console.log(`    Likelihood: ${data.likelihood} | Probability: ${data.driftProbability}%`)
  console.log(`    Reasoning : ${data.reasoning?.slice(0, 100)}…`)
  console.log(`    Fields at risk: ${data.fieldsAtRisk?.join(', ') || 'none'}`)
}

// ── 5. GET /api/ai/rg-recommendations ────────────────────────────────────────
async function testRgRecommendations() {
  console.log('\n[5] GET /api/ai/rg-recommendations')
  const res  = await fetch(`${API}/ai/rg-recommendations?subscriptionId=${SUB}&resourceGroup=${RG}`)
  assert(res.ok, `HTTP 200`, `got ${res.status}`)
  const data = await res.json()
  assert(Array.isArray(data), 'response is array')
  if (data.length > 0) {
    const r = data[0]
    assert(typeof r.title       === 'string', 'item has title')
    assert(typeof r.description === 'string', 'item has description')
    assert(typeof r.priority    === 'string', 'item has priority')
    console.log(`    ${data.length} recommendation(s). First: [${r.priority}] ${r.title}`)
  } else {
    console.log('    No recommendations (no drift history in RG)')
  }
}

// ── 6. GET /api/rg-prediction ─────────────────────────────────────────────────
async function testRgPrediction() {
  console.log('\n[6] GET /api/rg-prediction — RG bubble matrix + AI predictions')
  const start = Date.now()
  const res   = await fetch(`${API}/rg-prediction?subscriptionId=${SUB}&resourceGroup=${RG}`)
  const ms    = Date.now() - start
  assert(res.ok, `HTTP 200`, `got ${res.status}`)
  const data = await res.json()
  assert(Array.isArray(data.resourceStats),  'has resourceStats[]')
  assert(Array.isArray(data.aiPredictions),  'has aiPredictions[]')
  assert(typeof data.totalResources === 'number', 'has totalResources')
  console.log(`    Response time: ${ms}ms | resources: ${data.totalResources} | drifted: ${data.resourceStats.filter(r=>r.total>0).length}`)
  if (data.aiPredictions.length > 0) {
    const p = data.aiPredictions[0]
    assert(['HIGH','MEDIUM','LOW'].includes(p.likelihood), 'aiPrediction has valid likelihood')
    assert(typeof p.driftProbability === 'number',         'aiPrediction has driftProbability')
    console.log(`    Top prediction: ${p.resourceName} | ${p.likelihood} | ${p.driftProbability}%`)
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════')
  console.log('  Prediction & Forecasting — E2E Test Suite')
  console.log('═══════════════════════════════════════════════════')
  console.log(`  Subscription : ${SUB}`)
  console.log(`  Resource Group: ${RG}`)
  console.log(`  API Base      : ${API}`)

  const sample = await testDriftIndexHasRecords()
  const resourceId = sample?.resourceId || null

  const timeline7  = await testDriftRiskTimeline(7)
  await testDriftRiskTimeline(30)

  // Use resourceId from timeline series if available, else from Table index
  const predResourceId = timeline7?.series?.[0]?.resourceId || resourceId
  await testAiPredict(predResourceId)
  await testRgRecommendations()
  await testRgPrediction()

  console.log('\n═══════════════════════════════════════════════════')
  console.log(`  Results: ${passed} passed, ${failed} failed`)
  console.log('═══════════════════════════════════════════════════')
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
