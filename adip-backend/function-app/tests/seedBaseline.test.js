/**
 * Tests for seedBaseline Function
 * Run: node tests/seedBaseline.test.js
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') })
const fetch = require('node-fetch')
const { BlobServiceClient } = require('@azure/storage-blob')
const { blobKey } = require('adip-shared/blobHelpers')

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
const KEY  = process.env.SEED_FUNCTION_KEY || ''
const URL  = `${BASE}/seed-baseline${KEY ? `?code=${KEY}` : ''}`

const SUB = '8f461bb6-e3a4-468b-b134-8b1269337ac7'
const RG  = 'rg-adip'
// Use a real resource from rg-adip
const RES_ID = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Storage/storageAccounts/adipstore001`

async function main() {

  // ── Test 1: Function is reachable ───────────────────────────────────────────
  await test('seedBaseline function is reachable', async () => {
    const res = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert(res.status !== 404, `Function reachable (status: ${res.status})`)
  })

  // ── Test 2: Missing fields returns 400 ─────────────────────────────────────
  await test('Missing fields returns 400', async () => {
    const res = await fetch(URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptionId: SUB }),
    })
    assert(res.status === 400, `Returns 400 (got ${res.status})`)
    const body = await res.json()
    assert(body.error?.includes('required'), 'Error mentions required fields')
  })

  // ── Test 3: Seeds baseline for real resource ────────────────────────────────
  await test('Seeds baseline for adipstore001 storage account', async () => {
    const res = await fetch(URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptionId: SUB, resourceGroupId: RG, resourceId: RES_ID }),
    })
    assert(res.status === 200, `Returns 200 (got ${res.status})`)
    const body = await res.json()
    assert(body.message?.includes('seeded'), 'Response has seeded message')
    assert(body.baseline?.resourceId === RES_ID, 'baseline.resourceId matches')
    assert(body.baseline?.active === true, 'baseline.active is true')
    assert(body.baseline?.resourceState != null, 'baseline.resourceState is present')
    assert(body.baseline?.promotedAt != null, 'baseline.promotedAt is set')
  })

  // ── Test 4: Baseline blob exists in storage ─────────────────────────────────
  await test('Baseline blob written to storage', async () => {
    const blobSvc = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
    const ctr     = blobSvc.getContainerClient('baselines')
    const key     = blobKey(RES_ID)
    const blob    = ctr.getBlobClient(key)
    const exists  = await blob.exists()
    assert(exists, `Blob ${key} exists in baselines container`)

    const buf  = await blob.downloadToBuffer()
    const doc  = JSON.parse(buf.toString())
    assert(doc.subscriptionId === SUB, 'Stored doc has correct subscriptionId')
    assert(doc.resourceId === RES_ID, 'Stored doc has correct resourceId')
    assert(doc.resourceState != null, 'Stored doc has resourceState')
  })

  // ── Test 5: Express proxy module loads ──────────────────────────────────────
  await test('Express seed.js proxy module loads', async () => {
    const mod = require('../../express-api/src/routes/seed.js')
    assert(typeof mod === 'function' || typeof mod === 'object', 'seed.js exports a router')
  })

  console.log(`\n${'─'.repeat(50)}`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
