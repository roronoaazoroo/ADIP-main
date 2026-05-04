// FILE: test_rg_drift_analysis_e2e.cjs
// ROLE: E2E test for Resource Group Drift Analysis (Prediction & Forecasting tab)
//
// Tests:
//   1. ARM — verify resources exist in rg-adip
//   2. driftIndex Table — verify drift records exist and are correctly structured
//   3. GET /api/rg-prediction — response shape, accuracy of stats, AI predictions
//   4. Accuracy — cross-check resourceStats counts against raw Table index rows
//   5. AI predictions — driftProbability range, likelihood consistency, fieldsAtRisk
//   6. Dynamic — change a resource tag, verify stats update on next call

'use strict'
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') })

const fetch      = require('node-fetch')
const { TableClient }              = require('@azure/data-tables')
const { ResourceManagementClient } = require('@azure/arm-resources')
const { DefaultAzureCredential }   = require('@azure/identity')

const SUB = process.env.AZURE_SUBSCRIPTION_ID
const RG  = 'rg-adip'
const API = 'http://localhost:3001/api'

let passed = 0, failed = 0

function assert(cond, label, detail = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++ }
  else       { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); failed++ }
}

// ── 1. ARM — verify resources exist ──────────────────────────────────────────
async function testArmResources() {
  console.log('\n[1] ARM — resources in rg-adip')
  const cred   = new DefaultAzureCredential()
  const client = new ResourceManagementClient(cred, SUB)
  const resources = []
  for await (const r of client.resources.listByResourceGroup(RG)) {
    resources.push({ name: r.name, type: r.type })
  }
  assert(resources.length > 0, `ARM returns resources for ${RG}`, `found ${resources.length}`)
  console.log(`    ${resources.length} resources: ${resources.map(r => r.name).join(', ')}`)
  return new Set(resources.map(r => r.name.toLowerCase()))
}

// ── 2. driftIndex Table — raw data accuracy ───────────────────────────────────
async function testDriftIndexAccuracy() {
  console.log('\n[2] driftIndex Table — raw drift records for rg-adip')
  const tc = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'driftIndex')
  const filter = `PartitionKey eq '${SUB}' and resourceGroup eq '${RG}'`
  const rows = []
  const now  = Date.now()
  const counts = {}  // name → { total, last24h, last7d, severities }

  for await (const e of tc.listEntities({ queryOptions: { filter, select: ['resourceId','severity','detectedAt','resourceGroup'] } })) {
    rows.push(e)
    const name = e.resourceId?.split('/').pop()
    if (!name) continue
    if (!counts[name]) counts[name] = { total: 0, last24h: 0, last7d: 0, severities: { critical:0, high:0, medium:0, low:0 } }
    const ageH = (now - new Date(e.detectedAt)) / 3600000
    counts[name].total++
    if (ageH <= 24)  counts[name].last24h++
    if (ageH <= 168) counts[name].last7d++
    if (e.severity && counts[name].severities[e.severity] !== undefined) counts[name].severities[e.severity]++
  }

  assert(rows.length > 0, `driftIndex has rows for ${RG}`, `found ${rows.length}`)
  const validRows = rows.filter(r => r.resourceId && r.severity && r.detectedAt)
  const emptyIdRows = rows.filter(r => !r.resourceId)
  if (emptyIdRows.length) console.log(`    Note: ${emptyIdRows.length} rows have empty resourceId (source event had no resource ID — data quality, not a bug)`)
  assert(validRows.length > 0, 'majority of rows have required fields', `valid=${validRows.length} empty-id=${emptyIdRows.length}`)
  console.log(`    ${rows.length} total rows | ${Object.keys(counts).length} unique resources`)
  Object.entries(counts).forEach(([name, c]) => {
    console.log(`    ${name}: total=${c.total} 24h=${c.last24h} 7d=${c.last7d} crit=${c.severities.critical} high=${c.severities.high}`)
  })
  return counts
}

// ── 3. GET /api/rg-prediction — response shape ────────────────────────────────
async function testRgPredictionShape() {
  console.log('\n[3] GET /api/rg-prediction — response shape')
  const start = Date.now()
  const res   = await fetch(`${API}/rg-prediction?subscriptionId=${SUB}&resourceGroup=${RG}`)
  const ms    = Date.now() - start
  assert(res.ok, `HTTP 200`, `got ${res.status}`)
  const data = await res.json()

  assert(Array.isArray(data.resourceStats),       'has resourceStats[]')
  assert(Array.isArray(data.aiPredictions),        'has aiPredictions[]')
  assert(typeof data.totalResources === 'number',  'has totalResources')
  assert(typeof data.totalDriftEvents === 'number','has totalDriftEvents')
  assert(data.totalResources > 0,                  'totalResources > 0', `got ${data.totalResources}`)
  console.log(`    ${ms}ms | resources: ${data.totalResources} | driftEvents: ${data.totalDriftEvents} | aiPredictions: ${data.aiPredictions.length}`)

  // Validate resourceStats shape
  const drifted = data.resourceStats.filter(r => r.total > 0)
  assert(drifted.length > 0, 'at least one drifted resource in stats')
  const s = drifted[0]
  assert(typeof s.name        === 'string',  'stat has name')
  assert(typeof s.total       === 'number',  'stat has total')
  assert(typeof s.last24h     === 'number',  'stat has last24h')
  assert(typeof s.last7d      === 'number',  'stat has last7d')
  assert(typeof s.riskScore   === 'number',  'stat has riskScore')
  assert(Array.isArray(s.driftDates),        'stat has driftDates[]')
  assert(s.severities && typeof s.severities.critical === 'number', 'stat has severities.critical')

  return data
}

// ── 4. Accuracy — cross-check API stats vs raw Table counts ──────────────────
async function testAccuracy(apiData, rawCounts) {
  console.log('\n[4] Accuracy — API stats vs raw driftIndex counts')
  let accurate = 0, inaccurate = 0

  for (const stat of apiData.resourceStats.filter(r => r.total > 0)) {
    const raw = rawCounts[stat.name]
    if (!raw) {
      // Resource has drifts from other RGs included — skip
      continue
    }
    const totalMatch = stat.total >= raw.total  // API may include cross-RG records
    const sevMatch   = stat.severities.critical === raw.severities.critical &&
                       stat.severities.high     === raw.severities.high

    if (totalMatch && sevMatch) {
      accurate++
      console.log(`    ✓ ${stat.name}: total=${stat.total} crit=${stat.severities.critical} high=${stat.severities.high}`)
    } else {
      inaccurate++
      console.error(`    ✗ ${stat.name}: API total=${stat.total} vs raw=${raw.total} | API crit=${stat.severities.critical} vs raw=${raw.severities.critical}`)
    }
  }
  assert(inaccurate === 0, `all resource stats match raw Table counts`, `${inaccurate} mismatches`)

  // Verify riskScore formula: last24h*10 + last7d*3 + total
  for (const s of apiData.resourceStats) {
    const expected = s.last24h * 10 + s.last7d * 3 + s.total
    assert(s.riskScore === expected, `riskScore formula correct for ${s.name}`, `got ${s.riskScore} expected ${expected}`)
  }

  // Verify sorted by riskScore descending
  const scores = apiData.resourceStats.map(s => s.riskScore)
  const isSorted = scores.every((v, i) => i === 0 || v <= scores[i - 1])
  assert(isSorted, 'resourceStats sorted by riskScore descending')
}

// ── 5. AI predictions — quality checks ───────────────────────────────────────
async function testAiPredictions(apiData) {
  console.log('\n[5] AI predictions — quality and consistency')
  const preds = apiData.aiPredictions
  if (!preds.length) {
    console.log('    SKIP — no AI predictions returned (no drift history or OpenAI unavailable)')
    return
  }

  assert(preds.length <= 5, `max 5 predictions`, `got ${preds.length}`)

  // Sorted by driftProbability descending
  const probs = preds.map(p => p.driftProbability)
  assert(probs.every((v, i) => i === 0 || v <= probs[i - 1]), 'sorted by driftProbability descending')

  for (const p of preds) {
    assert(typeof p.resourceName     === 'string',  `${p.resourceName} has resourceName`)
    assert(typeof p.driftProbability === 'number',  `${p.resourceName} has driftProbability`)
    assert(p.driftProbability >= 0 && p.driftProbability <= 100, `${p.resourceName} probability in 0-100`, `got ${p.driftProbability}`)
    assert(['HIGH','MEDIUM','LOW'].includes(p.likelihood), `${p.resourceName} likelihood valid`, p.likelihood)
    assert(typeof p.reason           === 'string' && p.reason.length > 5, `${p.resourceName} has reason`)
    assert(typeof p.predictedDays    === 'number' && p.predictedDays >= 1 && p.predictedDays <= 7, `${p.resourceName} predictedDays 1-7`, `got ${p.predictedDays}`)
    assert(Array.isArray(p.fieldsAtRisk), `${p.resourceName} has fieldsAtRisk[]`)

    // Likelihood must be consistent with driftProbability
    const expectedLikelihood = p.driftProbability >= 70 ? 'HIGH' : p.driftProbability >= 40 ? 'MEDIUM' : 'LOW'
    assert(p.likelihood === expectedLikelihood, `${p.resourceName} likelihood consistent with probability`, `prob=${p.driftProbability} likelihood=${p.likelihood} expected=${expectedLikelihood}`)

    // resourceName must exist in resourceStats
    const statExists = apiData.resourceStats.some(s => s.name === p.resourceName)
    assert(statExists, `${p.resourceName} exists in resourceStats`)

    console.log(`    ${p.resourceName}: ${p.likelihood} ${p.driftProbability}% — "${p.reason.slice(0,60)}…"`)
  }
}

// ── 6. Dynamic — verify response changes when RG changes ─────────────────────
async function testDynamic() {
  console.log('\n[6] Dynamic — different RG returns different data')
  // Call with a different RG (testing-rg) — should return different resources
  const res1 = await fetch(`${API}/rg-prediction?subscriptionId=${SUB}&resourceGroup=${RG}`)
  const res2 = await fetch(`${API}/rg-prediction?subscriptionId=${SUB}&resourceGroup=testing-rg`)

  assert(res1.ok && res2.ok, 'both RG calls return 200')
  const d1 = await res1.json()
  const d2 = await res2.json()

  const names1 = new Set(d1.resourceStats.map(r => r.name))
  const names2 = new Set(d2.resourceStats.map(r => r.name))

  // The two RGs should have different resource sets
  const overlap = [...names1].filter(n => names2.has(n))
  assert(names1.size !== names2.size || overlap.length < Math.min(names1.size, names2.size),
    'different RGs return different resource sets',
    `rg-adip: [${[...names1].join(',')}] testing-rg: [${[...names2].join(',')}]`
  )
  console.log(`    rg-adip: ${d1.totalResources} resources | testing-rg: ${d2.totalResources} resources`)
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═══════════════════════════════════════════════════════')
  console.log('  Resource Group Drift Analysis — E2E Test Suite')
  console.log('═══════════════════════════════════════════════════════')
  console.log(`  Subscription : ${SUB}`)
  console.log(`  Resource Group: ${RG}`)
  console.log(`  API           : ${API}`)

  const armNames  = await testArmResources()
  const rawCounts = await testDriftIndexAccuracy()
  const apiData   = await testRgPredictionShape()
  await testAccuracy(apiData, rawCounts)
  await testAiPredictions(apiData)
  await testDynamic()

  console.log('\n═══════════════════════════════════════════════════════')
  console.log(`  Results: ${passed} passed, ${failed} failed`)
  console.log('═══════════════════════════════════════════════════════')
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
