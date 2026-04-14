/**
 * Tests for monitorResources Function
 * Run: node tests/monitorResources.test.js
 * Requires: STORAGE_CONNECTION_STRING and Azure credentials in .env
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') })
const { TableClient } = require('@azure/data-tables')

const CONN = process.env.STORAGE_CONNECTION_STRING
let passed = 0, failed = 0

async function main() {

function assert(condition, msg) {
  if (condition) { console.log(`  ✓ ${msg}`); passed++ }
  else           { console.error(`  ✗ ${msg}`); failed++ }
}

async function test(name, fn) {
  console.log(`\n[TEST] ${name}`)
  try { await fn() }
  catch (e) { console.error(`  ✗ threw: ${e.message}`); failed++ }
}

// ── Test 1: monitorSessions table is accessible ───────────────────────────────
await test('monitorSessions table exists and is accessible', async () => {
  const tc = TableClient.fromConnectionString(CONN, 'monitorSessions')
  let count = 0
  for await (const _ of tc.listEntities()) { count++; break }
  assert(true, 'Table is accessible (no error thrown)')
})

// ── Test 2: Can write and read a session ──────────────────────────────────────
await test('Write and read a monitor session', async () => {
  const tc  = TableClient.fromConnectionString(CONN, 'monitorSessions')
  const rk  = 'test-session-' + Date.now()
  const sub = 'test-sub-001'

  await tc.upsertEntity({
    partitionKey:    'session',
    rowKey:          rk,
    subscriptionId:  sub,
    resourceGroupId: 'rg-test',
    resourceId:      '',
    intervalMs:      60000,
    active:          true,
    startedAt:       new Date().toISOString(),
  }, 'Replace')

  const entity = await tc.getEntity('session', rk)
  assert(entity.subscriptionId === sub, 'subscriptionId matches')
  assert(entity.active === true, 'active is true')
  assert(entity.intervalMs === 60000, 'intervalMs is 60000')

  // Cleanup
  await tc.deleteEntity('session', rk)
  assert(true, 'Cleanup successful')
})

// ── Test 3: Can deactivate a session ─────────────────────────────────────────
await test('Deactivate a monitor session', async () => {
  const tc = TableClient.fromConnectionString(CONN, 'monitorSessions')
  const rk = 'test-deactivate-' + Date.now()

  await tc.upsertEntity({ partitionKey: 'session', rowKey: rk, subscriptionId: 'sub', resourceGroupId: 'rg', resourceId: '', active: true }, 'Replace')
  await tc.upsertEntity({ partitionKey: 'session', rowKey: rk, active: false }, 'Merge')

  const entity = await tc.getEntity('session', rk)
  assert(entity.active === false, 'Session deactivated')

  await tc.deleteEntity('session', rk)
})

// ── Test 4: Timer function module loads without error ─────────────────────────
await test('monitorResources/index.js loads without error', async () => {
  const fn = require('../monitorResources/index.js')
  assert(typeof fn === 'function', 'exports a function')
})

// ── Test 5: adip-shared modules resolve correctly ─────────────────────────────
await test('adip-shared modules resolve', async () => {
  const { strip, diffObjects } = require('adip-shared/diff')
  const { classifySeverity }   = require('adip-shared/severity')
  const { blobKey, driftKey }  = require('adip-shared/blobHelpers')

  assert(typeof strip === 'function', 'strip is a function')
  assert(typeof diffObjects === 'function', 'diffObjects is a function')
  assert(typeof classifySeverity === 'function', 'classifySeverity is a function')
  assert(typeof blobKey === 'function', 'blobKey is a function')
  assert(typeof driftKey === 'function', 'driftKey is a function')
})

// ── Test 6: diffObjects produces correct output ───────────────────────────────
await test('diffObjects detects changes correctly', async () => {
  const { diffObjects } = require('adip-shared/diff')
  const { classifySeverity } = require('adip-shared/severity')

  const prev = { properties: { networkAcls: { defaultAction: 'Deny' }, tier: 'Standard' } }
  const curr = { properties: { networkAcls: { defaultAction: 'Allow' }, tier: 'Standard' } }

  const changes = diffObjects(prev, curr)
  assert(changes.length === 1, 'detects 1 change')
  assert(changes[0].type === 'modified', 'change type is modified')
  assert(changes[0].path.includes('defaultAction'), 'path includes defaultAction')

  const severity = classifySeverity(changes)
  assert(severity === 'high', 'networkAcls change classified as high')
})

// ── Test 7: classifySeverity rules ────────────────────────────────────────────
await test('classifySeverity rules are correct', async () => {
  const { classifySeverity } = require('adip-shared/severity')

  assert(classifySeverity([]) === 'none', 'empty = none')
  assert(classifySeverity([{ type: 'removed', path: 'x' }]) === 'critical', 'removed = critical')
  assert(classifySeverity([{ type: 'modified', path: 'properties.networkAcls.x' }]) === 'high', 'networkAcls = high')
  assert(classifySeverity([1,2,3,4,5,6].map(i => ({ type: 'modified', path: `field${i}` }))) === 'medium', '>5 changes = medium')
  assert(classifySeverity([{ type: 'modified', path: 'tags.env' }]) === 'low', 'single tag = low')
})

// ── Test 8: blobKey is deterministic and URL-safe ─────────────────────────────
await test('blobKey is deterministic and URL-safe', async () => {
  const { blobKey } = require('adip-shared/blobHelpers')
  const id  = '/subscriptions/abc/resourceGroups/rg/providers/Microsoft.Network/networkSecurityGroups/nsg1'
  const key = blobKey(id)
  assert(key.endsWith('.json'), 'ends with .json')
  assert(!key.includes('/'), 'no forward slashes')
  assert(!key.includes('+'), 'no plus signs')
  assert(blobKey(id) === key, 'deterministic — same input same output')
})

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
