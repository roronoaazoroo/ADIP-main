/**
 * FULL PLATFORM TEST — Tests every major feature and function
 */
'use strict'
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../../.env') })

const SUB = '8f461bb6-e3a4-468b-b134-8b1269337ac7'
const RG = 'testing-rg'
let passed = 0, failed = 0, skipped = 0

function test(name, fn) { return { name, fn } }
function pass(name) { console.log(`  ✓ ${name}`); passed++ }
function fail(name, reason) { console.log(`  ✗ ${name} — ${reason}`); failed++ }
function skip(name, reason) { console.log(`  ⊘ ${name} — ${reason}`); skipped++ }

async function runTests(section, tests) {
  console.log(`\n═══ ${section} ═══`)
  for (const t of tests) {
    try {
      const result = await t.fn()
      if (result === 'skip') skip(t.name, 'not applicable')
      else pass(t.name)
    } catch (e) {
      fail(t.name, e.message?.slice(0, 100))
    }
  }
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║  ADIP FULL PLATFORM TEST SUITE                              ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')

  // ═══ 1. AZURE RESOURCE SERVICE ═══
  const { getResourceConfig, getApiVersion } = require('../../src/services/azureResourceService')
  await runTests('AZURE RESOURCE SERVICE', [
    test('getApiVersion — static map (Network)', async () => {
      const v = await getApiVersion(SUB, 'Microsoft.Network', 'virtualNetworks')
      if (!v) throw new Error('no version')
    }),
    test('getApiVersion — static map (Compute)', async () => {
      const v = await getApiVersion(SUB, 'Microsoft.Compute', 'virtualMachines')
      if (!v) throw new Error('no version')
    }),
    test('getResourceConfig — RG level (all resources)', async () => {
      const config = await getResourceConfig(SUB, RG, null)
      if (!config.resources?.length) throw new Error('no resources')
    }),
    test('getResourceConfig — single resource', async () => {
      const config = await getResourceConfig(SUB, RG, null)
      const first = config.resources[0]
      if (!first.id) throw new Error('no id on resource')
    }),
  ])

  // ═══ 2. BLOB SERVICE ═══
  const { saveBaseline, getBaseline, listGenomeSnapshots } = require('../../src/services/blobService')
  await runTests('BLOB SERVICE', [
    test('saveBaseline — writes to blob', async () => {
      await saveBaseline(SUB, RG, '__test__', { test: true, timestamp: Date.now() })
    }),
    test('getBaseline — reads from blob', async () => {
      const b = await getBaseline(SUB, RG)
      if (!b) throw new Error('no baseline returned')
    }),
    test('listGenomeSnapshots — returns array', async () => {
      const g = await listGenomeSnapshots(SUB, RG)
      if (!Array.isArray(g)) throw new Error('not array')
    }),
  ])

  // ═══ 3. DIFF ENGINE ═══
  const { diffObjects } = require('../../../shared/diff')
  const { VOLATILE } = require('../../../shared/constants')
  await runTests('DIFF ENGINE', [
    test('diffObjects — detects modification', () => {
      const d = diffObjects({ a: 1 }, { a: 2 })
      if (d.length !== 1) throw new Error(`expected 1 diff, got ${d.length}`)
    }),
    test('diffObjects — detects addition', () => {
      const d = diffObjects({}, { a: 1 })
      if (d.length !== 1) throw new Error(`expected 1 diff, got ${d.length}`)
    }),
    test('diffObjects — detects removal', () => {
      const d = diffObjects({ a: 1 }, {})
      if (d.length !== 1) throw new Error(`expected 1 diff, got ${d.length}`)
    }),
    test('diffObjects — strips volatile fields (macAddress)', () => {
      const d = diffObjects({ properties: { macAddress: 'AA' } }, { properties: { macAddress: 'BB' } })
      if (d.length !== 0) throw new Error(`volatile not stripped: ${d.length} diffs`)
    }),
    test('diffObjects — strips volatile fields (ipAddress)', () => {
      const d = diffObjects({ properties: { ipAddress: '1.1.1.1' } }, { properties: { ipAddress: '2.2.2.2' } })
      if (d.length !== 0) throw new Error(`volatile not stripped`)
    }),
    test('diffObjects — strips volatile fields (dnsSettings)', () => {
      const d = diffObjects({ properties: { dnsSettings: { x: 1 } } }, { properties: { dnsSettings: { x: 2 } } })
      if (d.length !== 0) throw new Error(`volatile not stripped`)
    }),
    test('diffObjects — strips volatile (LastOwnershipUpdateTime)', () => {
      const d = diffObjects({ properties: { LastOwnershipUpdateTime: 'a' } }, { properties: { LastOwnershipUpdateTime: 'b' } })
      if (d.length !== 0) throw new Error(`volatile not stripped`)
    }),
    test('diffObjects — resource array matches by name (order independent)', () => {
      const base = { resources: [{ name: 'a', type: 'x', val: 1 }, { name: 'b', type: 'y', val: 2 }] }
      const live = { resources: [{ name: 'b', type: 'y', val: 2 }, { name: 'a', type: 'x', val: 1 }] }
      const d = diffObjects(base, live)
      if (d.length !== 0) throw new Error(`order caused ${d.length} diffs`)
    }),
    test('diffObjects — resource array skips managed disks', () => {
      const base = { resources: [{ name: 'disk1', type: 'Microsoft.Compute/disks', id: '/d1' }] }
      const live = { resources: [{ name: 'disk2', type: 'Microsoft.Compute/disks', id: '/d2' }] }
      const d = diffObjects(base, live)
      if (d.length !== 0) throw new Error(`disk diff not skipped: ${d.length}`)
    }),
    test('VOLATILE array contains required fields', () => {
      const required = ['macAddress', 'primary', 'virtualMachine', 'ipAddress', 'dnsSettings', 'LastOwnershipUpdateTime', 'uniqueId']
      const missing = required.filter(f => !VOLATILE.includes(f))
      if (missing.length) throw new Error(`missing: ${missing.join(', ')}`)
    }),
  ])

  // ═══ 4. DEPLOYMENT ENGINE ═══
  const { sanitizeResource, buildDependencyGraph, topologicalSort, getLayer, getAuditLog, FLAGS } = require('../../src/services/deploymentEngine')
  await runTests('DEPLOYMENT ENGINE', [
    test('getLayer — correct ordering', () => {
      if (getLayer('Microsoft.Network/publicIPAddresses') !== 1) throw new Error('IP not L1')
      if (getLayer('Microsoft.Network/networkSecurityGroups') !== 1) throw new Error('NSG not L1')
      if (getLayer('Microsoft.Network/virtualNetworks') !== 2) throw new Error('VNet not L2')
      if (getLayer('Microsoft.Network/networkInterfaces') !== 3) throw new Error('NIC not L3')
      if (getLayer('Microsoft.Compute/virtualMachines') !== 5) throw new Error('VM not L5')
    }),
    test('sanitizeResource — removes provisioningState', () => {
      const s = sanitizeResource({ type: 'x', properties: { provisioningState: 'Succeeded' } })
      if (s.properties.provisioningState) throw new Error('not removed')
    }),
    test('sanitizeResource — removes vmId', () => {
      const s = sanitizeResource({ type: 'Microsoft.Compute/virtualMachines', properties: { vmId: '123', storageProfile: { osDisk: { createOption: 'Attach', managedDisk: { id: '/x' } } } } })
      if (s.properties.vmId) throw new Error('vmId not removed')
    }),
    test('sanitizeResource — VM osDisk.createOption = FromImage', () => {
      const s = sanitizeResource({ type: 'Microsoft.Compute/virtualMachines', properties: { storageProfile: { osDisk: { createOption: 'Attach', managedDisk: { id: '/x' } } } } })
      if (s.properties.storageProfile.osDisk.createOption !== 'FromImage') throw new Error('not FromImage')
    }),
    test('sanitizeResource — VM removes managedDisk ref', () => {
      const s = sanitizeResource({ type: 'Microsoft.Compute/virtualMachines', properties: { storageProfile: { osDisk: { createOption: 'Attach', managedDisk: { id: '/x' } } } } })
      if (s.properties.storageProfile.osDisk.managedDisk) throw new Error('managedDisk not removed')
    }),
    test('sanitizeResource — VM removes requireGuestProvisionSignal', () => {
      const s = sanitizeResource({ type: 'Microsoft.Compute/virtualMachines', properties: { osProfile: { requireGuestProvisionSignal: true }, storageProfile: { osDisk: {} } } })
      if (s.properties.osProfile.requireGuestProvisionSignal) throw new Error('not removed')
    }),
    test('sanitizeResource — preserves NIC id reference', () => {
      const s = sanitizeResource({ type: 'Microsoft.Compute/virtualMachines', properties: { networkProfile: { networkInterfaces: [{ id: '/sub/nic1' }] }, storageProfile: { osDisk: {} } } })
      if (!s.properties.networkProfile.networkInterfaces[0].id) throw new Error('NIC id lost')
    }),
    test('buildDependencyGraph — returns map', () => {
      const resources = [
        { name: 'vm', type: 'Microsoft.Compute/virtualMachines', id: '/vm', properties: { networkProfile: { networkInterfaces: [{ id: '/nic' }] } } },
        { name: 'nic', type: 'Microsoft.Network/networkInterfaces', id: '/nic', properties: { ipConfigurations: [{ properties: { subnet: { id: '/vnet/subnets/default' } } }] } },
        { name: 'vnet', type: 'Microsoft.Network/virtualNetworks', id: '/vnet', properties: {} },
      ]
      const g = buildDependencyGraph(resources)
      if (!g) throw new Error('no graph')
    }),
    test('topologicalSort — VM after NIC after VNet', () => {
      const resources = [
        { name: 'vm', type: 'Microsoft.Compute/virtualMachines', id: '/vm', properties: { networkProfile: { networkInterfaces: [{ id: '/nic' }] } } },
        { name: 'nic', type: 'Microsoft.Network/networkInterfaces', id: '/nic', properties: { ipConfigurations: [{ properties: { subnet: { id: '/vnet/subnets/default' } } }] } },
        { name: 'vnet', type: 'Microsoft.Network/virtualNetworks', id: '/vnet', properties: {} },
      ]
      const g = buildDependencyGraph(resources)
      const sorted = topologicalSort(resources, g)
      const vmIdx = sorted.findIndex(r => r.name === 'vm')
      const nicIdx = sorted.findIndex(r => r.name === 'nic')
      const vnetIdx = sorted.findIndex(r => r.name === 'vnet')
      if (vmIdx <= nicIdx) throw new Error('VM before NIC')
      if (nicIdx <= vnetIdx) throw new Error('NIC before VNet')
    }),
    test('FLAGS — feature flags exist', () => {
      if (typeof FLAGS.enableAutoRemediation !== 'boolean') throw new Error('missing flag')
      if (typeof FLAGS.maxRetries !== 'number') throw new Error('missing maxRetries')
    }),
    test('getAuditLog — returns array', () => {
      const log = getAuditLog()
      if (!Array.isArray(log)) throw new Error('not array')
    }),
  ])

  // ═══ 5. SEVERITY CLASSIFICATION ═══
  const { classifySeverity } = require('../../../shared/severity')
  await runTests('SEVERITY CLASSIFICATION', [
    test('classifySeverity — critical (field deleted)', () => {
      const s = classifySeverity([{ type: 'removed', path: 'properties → x' }])
      if (s !== 'critical') throw new Error(`got ${s}`)
    }),
    test('classifySeverity — high (security field)', () => {
      const s = classifySeverity([{ type: 'modified', path: 'properties → networkAcls → x' }])
      if (s !== 'high') throw new Error(`got ${s}`)
    }),
    test('classifySeverity — low (single non-security change)', () => {
      const s = classifySeverity([{ type: 'modified', path: 'tags → env' }])
      if (s !== 'low') throw new Error(`got ${s}`)
    }),
  ])

  // ═══ 6. BASELINE VALIDATION ENDPOINT ═══
  await runTests('BASELINE VALIDATION', [
    test('POST /api/baseline/validate — logic works', async () => {
      // Test the logic directly
      const baseline = await getBaseline(SUB, RG)
      const resources = baseline.resourceState?.resources || baseline.resources || []
      if (!resources.length) throw new Error('no resources in baseline')
      const vm = resources.find(r => r.type?.toLowerCase().includes('virtualmachines'))
      if (!vm) throw new Error('VM not in baseline')
      const graph = buildDependencyGraph(resources)
      const sorted = topologicalSort(resources, graph)
      if (sorted.length !== resources.length) throw new Error('sort incomplete')
    }),
  ])

  // ═══ 7. LIVE AZURE STATE VALIDATION ═══
  const { ResourceManagementClient } = require('@azure/arm-resources')
  const { DefaultAzureCredential } = require('@azure/identity')
  const credential = new DefaultAzureCredential()
  const armClient = new ResourceManagementClient(credential, SUB)
  await runTests('AZURE STATE VALIDATION', [
    test('VM exists and Succeeded', async () => {
      const { ComputeManagementClient } = require('@azure/arm-compute')
      const cc = new ComputeManagementClient(credential, SUB)
      const vm = await cc.virtualMachines.get(RG, 'testing-vm')
      if (vm.provisioningState !== 'Succeeded') throw new Error(`state: ${vm.provisioningState}`)
    }),
    test('NIC exists and Succeeded', async () => {
      const { NetworkManagementClient } = require('@azure/arm-network')
      const nc = new NetworkManagementClient(credential, SUB)
      const nic = await nc.networkInterfaces.get(RG, 'testing-vm798')
      if (nic.provisioningState !== 'Succeeded') throw new Error(`state: ${nic.provisioningState}`)
    }),
    test('NIC has subnet binding', async () => {
      const { NetworkManagementClient } = require('@azure/arm-network')
      const nc = new NetworkManagementClient(credential, SUB)
      const nic = await nc.networkInterfaces.get(RG, 'testing-vm798')
      if (!nic.ipConfigurations?.[0]?.subnet?.id) throw new Error('no subnet')
    }),
    test('NIC has NSG association', async () => {
      const { NetworkManagementClient } = require('@azure/arm-network')
      const nc = new NetworkManagementClient(credential, SUB)
      const nic = await nc.networkInterfaces.get(RG, 'testing-vm798')
      if (!nic.networkSecurityGroup?.id) throw new Error('no NSG')
    }),
    test('NSG exists', async () => {
      const { NetworkManagementClient } = require('@azure/arm-network')
      const nc = new NetworkManagementClient(credential, SUB)
      const nsg = await nc.networkSecurityGroups.get(RG, 'testing-vm-nsg')
      if (nsg.provisioningState !== 'Succeeded') throw new Error(`state: ${nsg.provisioningState}`)
    }),
    test('VNet exists with subnet', async () => {
      const { NetworkManagementClient } = require('@azure/arm-network')
      const nc = new NetworkManagementClient(credential, SUB)
      const vnet = await nc.virtualNetworks.get(RG, 'testing-vm-vnet')
      if (!vnet.subnets?.length) throw new Error('no subnets')
    }),
    test('Public IP exists', async () => {
      const { NetworkManagementClient } = require('@azure/arm-network')
      const nc = new NetworkManagementClient(credential, SUB)
      const ip = await nc.publicIPAddresses.get(RG, 'testing-vm-ip')
      if (ip.provisioningState !== 'Succeeded') throw new Error(`state: ${ip.provisioningState}`)
    }),
  ])

  // ═══ 8. DRIFT COMPARISON (post-remediation) ═══
  await runTests('DRIFT COMPARISON', [
    test('Zero drift between baseline and live (server-side)', async () => {
      const baseline = await getBaseline(SUB, RG)
      const live = await getResourceConfig(SUB, RG, null)
      const diffs = diffObjects(baseline.resourceState || baseline, live)
      if (diffs.length > 0) throw new Error(`${diffs.length} diffs: ${diffs.map(d => d.path).join(', ')}`)
    }),
  ])

  // ═══ 9. AUTH SYSTEM ═══
  await runTests('AUTH SYSTEM', [
    test('auth routes file loads', () => {
      require('../../src/routes/auth')
    }),
    test('authMiddleware loads', () => {
      require('../../src/middleware/authMiddleware')
    }),
  ])

  // ═══ 10. FRONTEND BUILD ═══
  await runTests('FRONTEND BUILD', [
    test('Vite build succeeds', async () => {
      const { execSync } = require('child_process')
      const out = execSync('npm run build 2>&1', { cwd: require('path').resolve(__dirname, '../../../../'), encoding: 'utf-8' })
      if (!out.includes('built in')) throw new Error('build failed')
    }),
  ])

  // ═══ FINAL REPORT ═══
  const total = passed + failed + skipped
  console.log('\n╔══════════════════════════════════════════════════════════════╗')
  console.log(`║  RESULTS: ${passed} passed, ${failed} failed, ${skipped} skipped (${total} total)`)
  console.log(`║  Score: ${Math.round((passed / (passed + failed)) * 100)}%`)
  console.log(`║  ${failed === 0 ? '✓ ALL TESTS PASSED' : '✗ FAILURES DETECTED'}`)
  console.log('╚══════════════════════════════════════════════════════════════╝')
  
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(e => { console.error('FATAL:', e); process.exit(1) })
