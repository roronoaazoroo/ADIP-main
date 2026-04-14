/**
 * Tests for aiOperations Function
 * Run: node tests/aiOperations.test.js
 * Requires: AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_KEY, FUNCTION_APP_URL, AI_FUNCTION_KEY in .env
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') })
const fetch = require('node-fetch')

let passed = 0, failed = 0

function assert(condition, msg) {
  if (condition) { console.log(`  ✓ ${msg}`); passed++ }
  else           { console.error(`  ✗ ${msg}`); failed++ }
}

async function test(name, fn) {
  console.log(`\n[TEST] ${name}`)
  try { await fn() }
  catch (e) { console.error(`  ✗ threw: ${e.message}`); failed++ }
}

const BASE = process.env.FUNCTION_APP_URL?.replace(/\/$/, '') || 'https://adip-func-001.azurewebsites.net/api'
const KEY  = process.env.AI_FUNCTION_KEY || ''

function url(op) { return `${BASE}/ai/${op}${KEY ? `?code=${KEY}` : ''}` }

const SAMPLE_RECORD = {
  resourceId:    '/subscriptions/8f461bb6/resourceGroups/rg-adip/providers/Microsoft.Network/networkSecurityGroups/test-nsg',
  resourceGroup: 'rg-adip',
  severity:      'high',
  differences: [
    { path: 'properties.securityRules → AllowHTTP → properties.access', type: 'modified', oldValue: 'Deny', newValue: 'Allow', sentence: 'changed "access" from "Deny" to "Allow"' }
  ],
  changes: [
    { path: 'properties.securityRules → AllowHTTP → properties.access', type: 'modified', oldValue: 'Deny', newValue: 'Allow', sentence: 'changed "access" from "Deny" to "Allow"' }
  ]
}

async function main() {

  // ── Test 1: Function is reachable ───────────────────────────────────────────
  await test('aiOperations function is reachable', async () => {
    const res = await fetch(url('explain'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
    // May return 500 if OpenAI not configured, but should not be 404
    assert(res.status !== 404, `Function reachable (status: ${res.status})`)
  })

  // ── Test 2: Unknown operation returns 404 ───────────────────────────────────
  await test('Unknown operation returns 404', async () => {
    const res = await fetch(url('unknown'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert(res.status === 404, `Returns 404 for unknown op (got ${res.status})`)
    const body = await res.json()
    assert(body.error?.includes('Unknown'), 'Error message mentions Unknown')
  })

  // ── Test 3: Wrong HTTP method returns 405 ───────────────────────────────────
  await test('GET on explain returns 405', async () => {
    const res = await fetch(url('explain'), { method: 'GET' })
    assert(res.status === 405, `Returns 405 for wrong method (got ${res.status})`)
  })

  // ── Test 4: anomalies requires subscriptionId ───────────────────────────────
  await test('anomalies without subscriptionId returns 400', async () => {
    const res = await fetch(url('anomalies'), { method: 'GET' })
    assert(res.status === 400, `Returns 400 without subscriptionId (got ${res.status})`)
    const body = await res.json()
    assert(body.error?.includes('subscriptionId'), 'Error mentions subscriptionId')
  })

  // ── Test 5: explain returns explanation field ───────────────────────────────
  await test('explain returns { explanation } field', async () => {
    const res = await fetch(url('explain'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SAMPLE_RECORD),
    })
    assert(res.status === 200, `Returns 200 (got ${res.status})`)
    const body = await res.json()
    assert('explanation' in body, 'Response has explanation field')
    assert(typeof body.explanation === 'string' || body.explanation === null, 'explanation is string or null')
    if (body.explanation) {
      assert(body.explanation.length > 10, `explanation has content: "${body.explanation.slice(0, 60)}..."`)
    }
  })

  // ── Test 6: severity returns severity + reasoning ───────────────────────────
  await test('severity returns { severity, reasoning }', async () => {
    const res = await fetch(url('severity'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SAMPLE_RECORD),
    })
    assert(res.status === 200, `Returns 200 (got ${res.status})`)
    const body = await res.json()
    assert(['critical','high','medium','low'].includes(body.severity), `severity is valid: ${body.severity}`)
    assert(typeof body.reasoning === 'string', 'reasoning is a string')
  })

  // ── Test 7: recommend returns recommendation field ──────────────────────────
  await test('recommend returns { recommendation } field', async () => {
    const res = await fetch(url('recommend'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SAMPLE_RECORD),
    })
    assert(res.status === 200, `Returns 200 (got ${res.status})`)
    const body = await res.json()
    assert('recommendation' in body, 'Response has recommendation field')
    assert(typeof body.recommendation === 'string' || body.recommendation === null, 'recommendation is string or null')
  })

  // ── Test 8: anomalies returns { anomalies } array ───────────────────────────
  await test('anomalies returns { anomalies } array', async () => {
    const res = await fetch(`${url('anomalies')}&subscriptionId=8f461bb6-e3a4-468b-b134-8b1269337ac7`, { method: 'GET' })
    assert(res.status === 200, `Returns 200 (got ${res.status})`)
    const body = await res.json()
    assert('anomalies' in body, 'Response has anomalies field')
    assert(Array.isArray(body.anomalies), 'anomalies is an array')
    console.log(`  ℹ anomalies found: ${body.anomalies.length}`)
  })

  // ── Test 9: Express proxy routes are registered ─────────────────────────────
  await test('Express ai.js proxy module loads without error', async () => {
    // Just verify the module syntax is valid
    const mod = require('../../express-api/src/routes/ai.js')
    assert(typeof mod === 'function' || typeof mod === 'object', 'ai.js exports a router')
  })

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
