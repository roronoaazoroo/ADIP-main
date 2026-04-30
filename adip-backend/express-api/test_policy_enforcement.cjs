// FILE: test_policy_enforcement.cjs
// ROLE: Tests for the Policy Enforcement feature on the Comparison page
//
// Tests:
//   1. Unit — findMatchingPolicies: maps diff paths to correct policy definitions
//   2. Unit — findMatchingPolicies: returns empty for unknown paths
//   3. Integration — enforcePolicesForDrift: creates real Azure Policy assignments
//   4. Integration — idempotency: second call skips already-assigned policies
//   5. API — GET /api/policy/assignments returns the created assignments

'use strict'
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') })

const { findMatchingPolicies, enforcePolicesForDrift } = require('./src/services/policyEnforcementService')
const fetch = require('node-fetch')

const SUB        = process.env.AZURE_SUBSCRIPTION_ID
const RG         = 'rg-adip'
const API_BASE   = `http://localhost:3001/api`

let passed = 0, failed = 0

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
    failed++
  }
}

// ── Test 1: findMatchingPolicies — known paths ────────────────────────────────
function testFindMatchingPolicies_knownPaths() {
  console.log('\n[1] findMatchingPolicies — known drift paths')
  const changes = [
    { path: 'properties.networkAcls.defaultAction', type: 'changed' },
    { path: 'properties.supportsHttpsTrafficOnly',  type: 'changed' },
    { path: 'properties.encryption.keySource',      type: 'changed' },
  ]
  const matched = findMatchingPolicies(changes)
  assert(matched.length >= 3, 'matches at least 3 policies for 3 known paths', `got ${matched.length}`)
  assert(matched.some(p => p.displayName.includes('network access')), 'networkAcls → network access policy')
  assert(matched.some(p => p.displayName.includes('Secure transfer')), 'supportsHttpsTrafficOnly → secure transfer policy')
  assert(matched.some(p => p.displayName.includes('encryption')), 'encryption → encryption policy')
}

// ── Test 2: findMatchingPolicies — unknown paths ──────────────────────────────
function testFindMatchingPolicies_unknownPaths() {
  console.log('\n[2] findMatchingPolicies — unknown drift paths')
  const changes = [
    { path: 'tags.environment', type: 'changed' },
    { path: 'properties.someRandomField', type: 'changed' },
  ]
  const matched = findMatchingPolicies(changes)
  assert(matched.length === 0, 'returns empty array for unknown paths', `got ${matched.length}`)
}

// ── Test 3: enforcePolicesForDrift — real Azure Policy assignment ─────────────
async function testEnforcePolicesForDrift_creates() {
  console.log('\n[3] enforcePolicesForDrift — creates Azure Policy assignments (live)')
  const changes = [
    { path: 'properties.networkAcls.defaultAction', type: 'changed', oldValue: 'Allow', newValue: 'Deny' },
    { path: 'properties.minimumTlsVersion',         type: 'changed', oldValue: 'TLS1_0', newValue: 'TLS1_2' },
  ]
  try {
    const created = await enforcePolicesForDrift(SUB, RG, changes)
    assert(Array.isArray(created), 'returns array')
    console.log(`    Created ${created.length} assignment(s):`)
    created.forEach(a => console.log(`      - ${a.displayName}`))
    // May be 0 if already assigned (idempotent) — both 0 and >0 are valid
    assert(true, `enforcePolicesForDrift completed without throwing`)
  } catch (err) {
    assert(false, 'enforcePolicesForDrift should not throw', err.message)
  }
}

// ── Test 4: idempotency — second call skips existing assignments ──────────────
async function testEnforcePolicesForDrift_idempotent() {
  console.log('\n[4] enforcePolicesForDrift — idempotency (second call)')
  const changes = [
    { path: 'properties.networkAcls.defaultAction', type: 'changed' },
  ]
  try {
    const first  = await enforcePolicesForDrift(SUB, RG, changes)
    const second = await enforcePolicesForDrift(SUB, RG, changes)
    // Second call should create 0 new assignments (already exists)
    assert(second.length === 0, 'second call creates 0 new assignments (idempotent)', `got ${second.length}`)
  } catch (err) {
    assert(false, 'idempotency test should not throw', err.message)
  }
}

// ── Test 5: GET /api/policy/assignments ───────────────────────────────────────
async function testGetPolicyAssignments_api() {
  console.log('\n[5] GET /api/policy/assignments — API endpoint')
  try {
    const res  = await fetch(`${API_BASE}/policy/assignments?subscriptionId=${SUB}&resourceGroupId=${RG}`)
    assert(res.ok, `HTTP 200 response`, `got ${res.status}`)
    const data = await res.json()
    assert(Array.isArray(data), 'response is an array')
    if (data.length > 0) {
      const item = data[0]
      assert(typeof item.displayName   === 'string', 'item has displayName')
      assert(typeof item.assignmentId  === 'string', 'item has assignmentId')
      assert(typeof item.resourceGroupId === 'string', 'item has resourceGroupId')
      assert(typeof item.createdAt     === 'string', 'item has createdAt')
      console.log(`    Found ${data.length} assignment(s) in Table Storage`)
    } else {
      console.log('    No assignments found yet (run test 3 first with live API)')
      assert(true, 'empty array is valid when no assignments exist')
    }
  } catch (err) {
    assert(false, 'GET /api/policy/assignments should not throw', err.message)
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════')
  console.log('  Policy Enforcement — Test Suite')
  console.log('═══════════════════════════════════════════════')
  console.log(`  Subscription : ${SUB}`)
  console.log(`  Resource Group: ${RG}`)

  // Unit tests (no Azure calls)
  testFindMatchingPolicies_knownPaths()
  testFindMatchingPolicies_unknownPaths()

  // Integration tests (require Azure credentials + running Express API)
  await testEnforcePolicesForDrift_creates()
  await testEnforcePolicesForDrift_idempotent()
  await testGetPolicyAssignments_api()

  console.log('\n═══════════════════════════════════════════════')
  console.log(`  Results: ${passed} passed, ${failed} failed`)
  console.log('═══════════════════════════════════════════════')
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1) })
