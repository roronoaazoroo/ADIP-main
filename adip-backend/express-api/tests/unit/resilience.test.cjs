/**
 * FILE: adip-backend/express-api/tests/unit/resilience.test.cjs
 * ROLE: Unit tests for reliability features (Phase 5 validation)
 */
'use strict'
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../../.env') })

let passed = 0, failed = 0
function assert(cond, msg) { if (cond) { console.log(`  ✓ ${msg}`); passed++ } else { console.log(`  ✗ ${msg}`); failed++ } }

async function main() {
  console.log('═══ RESILIENCE TESTS ═══\n')

  // 1. Circuit breaker behavior
  console.log('── Circuit Breaker ──')
  const { CircuitBreaker } = require('../../src/shared/circuitBreaker')
  
  const cb = new CircuitBreaker('test-cb', { failureThreshold: 3, resetTimeout: 200 })
  
  // Success keeps circuit closed
  await cb.call(() => Promise.resolve('ok'))
  assert(cb.getState().state === 'CLOSED', 'stays closed on success')
  
  // Failures open circuit
  for (let i = 0; i < 3; i++) { try { await cb.call(() => { throw new Error('x') }) } catch {} }
  assert(cb.getState().state === 'OPEN', 'opens after 3 failures')
  
  // Rejects immediately when open
  try { await cb.call(() => 'ok'); assert(false, 'should throw') } catch (e) { assert(e.message.includes('OPEN'), 'rejects when open') }
  
  // Resets after timeout
  await new Promise(r => setTimeout(r, 250))
  const result = await cb.call(() => Promise.resolve('recovered'))
  assert(result === 'recovered', 'recovers after reset timeout')
  assert(cb.getState().state === 'CLOSED', 'closes after successful half-open call')

  // 2. ARM cache
  console.log('\n── ARM Cache ──')
  const { getCached, setCache, invalidateCache } = require('../../src/shared/armCache')
  setCache('sub1', 'rg1', null, { test: true })
  assert(getCached('sub1', 'rg1', null)?.test === true, 'cache stores and retrieves')
  assert(getCached('sub1', 'rg2', null) === null, 'cache miss returns null')
  invalidateCache('sub1', 'rg1', null)
  assert(getCached('sub1', 'rg1', null) === null, 'invalidation works')

  // 3. Deployment engine safety
  console.log('\n── Deployment Engine ──')
  const { sanitizeResource, getLayer, buildDependencyGraph, topologicalSort } = require('../../src/services/deploymentEngine')
  
  // VM sanitization
  const vm = sanitizeResource({ type: 'Microsoft.Compute/virtualMachines', properties: { provisioningState: 'Succeeded', vmId: '123', osProfile: { requireGuestProvisionSignal: true }, storageProfile: { osDisk: { createOption: 'Attach', managedDisk: { id: '/x' } } }, networkProfile: { networkInterfaces: [{ id: '/nic1' }] } } })
  assert(!vm.properties.provisioningState, 'removes provisioningState')
  assert(!vm.properties.vmId, 'removes vmId')
  assert(!vm.properties.osProfile.requireGuestProvisionSignal, 'removes requireGuestProvisionSignal')
  assert(vm.properties.storageProfile.osDisk.createOption === 'FromImage', 'sets FromImage')
  assert(!vm.properties.storageProfile.osDisk.managedDisk, 'removes stale managedDisk')
  assert(vm.properties.networkProfile.networkInterfaces[0].id === '/nic1', 'preserves NIC ref')
  
  // Layer ordering
  assert(getLayer('Microsoft.Network/publicIPAddresses') < getLayer('Microsoft.Network/networkInterfaces'), 'IP before NIC')
  assert(getLayer('Microsoft.Network/networkInterfaces') < getLayer('Microsoft.Compute/virtualMachines'), 'NIC before VM')

  // Dependency graph
  const resources = [
    { name: 'vm', type: 'Microsoft.Compute/virtualMachines', id: '/vm', properties: { networkProfile: { networkInterfaces: [{ id: '/nic' }] } } },
    { name: 'nic', type: 'Microsoft.Network/networkInterfaces', id: '/nic', properties: { ipConfigurations: [{ properties: { subnet: { id: '/vnet/subnets/default' } } }] } },
    { name: 'vnet', type: 'Microsoft.Network/virtualNetworks', id: '/vnet', properties: {} },
  ]
  const graph = buildDependencyGraph(resources)
  const sorted = topologicalSort(resources, graph)
  const vmIdx = sorted.findIndex(r => r.name === 'vm')
  const nicIdx = sorted.findIndex(r => r.name === 'nic')
  const vnetIdx = sorted.findIndex(r => r.name === 'vnet')
  assert(vmIdx > nicIdx && nicIdx > vnetIdx, 'topological sort: VNet → NIC → VM')

  // 4. Diff engine volatile stripping
  console.log('\n── Diff Engine ──')
  const { diffObjects } = require('../../../shared/diff')
  const { VOLATILE } = require('../../../shared/constants')
  
  assert(VOLATILE.includes('macAddress'), 'VOLATILE has macAddress')
  assert(VOLATILE.includes('ipAddress'), 'VOLATILE has ipAddress')
  assert(VOLATILE.includes('LastOwnershipUpdateTime'), 'VOLATILE has LastOwnershipUpdateTime')
  
  const d1 = diffObjects({ properties: { macAddress: 'AA' } }, { properties: { macAddress: 'BB' } })
  assert(d1.length === 0, 'strips macAddress from diff')
  
  const d2 = diffObjects({ properties: { tags: { env: 'prod' } } }, { properties: { tags: { env: 'dev' } } })
  assert(d2.length === 1, 'detects real changes')

  // 5. AI orchestrator safety
  console.log('\n── AI Orchestrator ──')
  const { getHealthStatus } = require('../../src/services/aiOrchestrator')
  const health = getHealthStatus()
  assert(health.openai !== undefined, 'reports OpenAI circuit state')
  assert(typeof health.cacheSize === 'number', 'reports cache size')

  console.log(`\n═══ RESULTS: ${passed} passed, ${failed} failed ═══`)
  process.exit(failed === 0 ? 0 : 1)
}
main().catch(e => { console.error('FATAL:', e); process.exit(1) })
