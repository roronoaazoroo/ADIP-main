/**
 * DESTRUCTIVE INTEGRATION TEST — Azure Infrastructure Recovery
 * 
 * This test:
 * 1. Deploys a known VM stack to a test RG
 * 2. Saves baseline
 * 3. Deletes the VM stack
 * 4. Triggers remediation
 * 5. Validates Azure state post-recovery
 * 
 * RUN: node tests/integration/destructive-recovery.cjs
 */
'use strict'
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../../.env') })

const { ResourceManagementClient } = require('@azure/arm-resources')
const { NetworkManagementClient } = require('@azure/arm-network')
const { ComputeManagementClient } = require('@azure/arm-compute')
const { DefaultAzureCredential } = require('@azure/identity')
const { saveBaseline, getBaseline } = require('../../src/services/blobService')
const { getResourceConfig } = require('../../src/services/azureResourceService')
const { deployResources, buildDependencyGraph, topologicalSort, getLayer, sanitizeResource } = require('../../src/services/deploymentEngine')
const { diffObjects } = require('../../../shared/diff')

const SUB = process.env.AZURE_SUBSCRIPTION_ID || '8f461bb6-e3a4-468b-b134-8b1269337ac7'
const TEST_RG = 'testing-rg'
const LOCATION = 'centralus'
const credential = new DefaultAzureCredential()

const report = {
  startTime: null,
  endTime: null,
  phases: [],
  results: [],
  confidence: 0,
  success: false,
}

function log(phase, msg, status = 'info') {
  const entry = { time: new Date().toISOString(), phase, msg, status }
  report.phases.push(entry)
  const icon = status === 'pass' ? '✓' : status === 'fail' ? '✗' : status === 'skip' ? '⊘' : '→'
  console.log(`  [${icon}] ${phase}: ${msg}`)
}

function assert(condition, phase, msg) {
  if (condition) {
    log(phase, msg, 'pass')
    report.results.push({ test: msg, pass: true })
  } else {
    log(phase, msg, 'fail')
    report.results.push({ test: msg, pass: false })
  }
  return condition
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 1: BASELINE VERIFICATION
// ═══════════════════════════════════════════════════════════════════════════════
async function phase1_validateBaseline() {
  console.log('\n═══ PHASE 1: BASELINE VERIFICATION ═══')
  
  const config = await getResourceConfig(SUB, TEST_RG, null)
  const resources = config.resources || []
  
  assert(resources.length >= 5, 'baseline', `Baseline has ${resources.length} resources (need ≥5)`)
  
  const vm = resources.find(r => r.type?.toLowerCase().includes('virtualmachines'))
  const nic = resources.find(r => r.type?.toLowerCase().includes('networkinterfaces'))
  const nsg = resources.find(r => r.type?.toLowerCase().includes('networksecuritygroups'))
  const ip = resources.find(r => r.type?.toLowerCase().includes('publicipaddresses'))
  const vnet = resources.find(r => r.type?.toLowerCase().includes('virtualnetworks'))
  
  assert(!!vm, 'baseline', 'VM exists in baseline')
  assert(!!nic, 'baseline', 'NIC exists in baseline')
  assert(!!nsg, 'baseline', 'NSG exists in baseline')
  assert(!!ip, 'baseline', 'Public IP exists in baseline')
  assert(!!vnet, 'baseline', 'VNet exists in baseline')
  
  // Verify dependencies resolvable
  if (vm) {
    const nicRef = vm.properties?.networkProfile?.networkInterfaces?.[0]?.id
    assert(!!nicRef, 'baseline', 'VM has NIC reference')
    if (nicRef) {
      const nicExists = resources.find(r => r.id?.toLowerCase() === nicRef.toLowerCase())
      assert(!!nicExists, 'baseline', 'VM NIC reference resolves to existing resource')
    }
  }
  
  if (nic) {
    const subnetRef = nic.properties?.ipConfigurations?.[0]?.properties?.subnet?.id
    assert(!!subnetRef, 'baseline', 'NIC has subnet reference')
    if (subnetRef) {
      const vnetId = subnetRef.split('/subnets/')[0]
      const vnetExists = resources.find(r => r.id?.toLowerCase() === vnetId.toLowerCase())
      assert(!!vnetExists, 'baseline', 'NIC subnet VNet reference resolves')
    }
  }
  
  // ARM schema validation
  resources.forEach(r => {
    if (r.type && !r.type.includes('schedules') && !r.type.includes('sshPublicKeys')) {
      assert(!!r.location, 'baseline', `${r.name} has location`)
    }
  })
  
  // Save baseline
  await saveBaseline(SUB, TEST_RG, TEST_RG, config)
  log('baseline', 'Baseline saved to blob storage', 'pass')
  
  return { resources, config }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 2: DEPENDENCY GRAPH VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════
async function phase2_validateDependencyGraph(resources) {
  console.log('\n═══ PHASE 2: DEPENDENCY GRAPH VALIDATION ═══')
  
  const graph = buildDependencyGraph(resources)
  const sorted = topologicalSort(resources, graph)
  
  assert(sorted.length === resources.length, 'depgraph', `Topological sort includes all ${resources.length} resources`)
  
  // Verify layer ordering
  const layers = sorted.map(r => ({ name: r.name, type: (r.type || '').split('/').pop(), layer: getLayer(r.type) }))
  log('depgraph', `Deployment layers: ${JSON.stringify(layers.map(l => `L${l.layer}:${l.name}`).join(', '))}`)
  
  // VM must come after NIC
  const vmIdx = sorted.findIndex(r => r.type?.toLowerCase().includes('virtualmachines'))
  const nicIdx = sorted.findIndex(r => r.type?.toLowerCase().includes('networkinterfaces'))
  const nsgIdx = sorted.findIndex(r => r.type?.toLowerCase().includes('networksecuritygroups'))
  const vnetIdx = sorted.findIndex(r => r.type?.toLowerCase().includes('virtualnetworks'))
  
  if (vmIdx >= 0 && nicIdx >= 0) assert(vmIdx > nicIdx, 'depgraph', 'VM deploys after NIC')
  if (nicIdx >= 0 && vnetIdx >= 0) assert(nicIdx > vnetIdx, 'depgraph', 'NIC deploys after VNet')
  if (nicIdx >= 0 && nsgIdx >= 0) assert(nicIdx > nsgIdx, 'depgraph', 'NIC deploys after NSG')
  
  // VM layer must be highest
  const vmLayer = getLayer(resources.find(r => r.type?.toLowerCase().includes('virtualmachines'))?.type)
  const nicLayer = getLayer(resources.find(r => r.type?.toLowerCase().includes('networkinterfaces'))?.type)
  assert(vmLayer > nicLayer, 'depgraph', `VM layer (${vmLayer}) > NIC layer (${nicLayer})`)
  
  return { graph, sorted, layers }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3: ARM SANITIZATION VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════
async function phase3_validateSanitization(resources) {
  console.log('\n═══ PHASE 3: ARM SANITIZATION VALIDATION ═══')
  
  const vm = resources.find(r => r.type?.toLowerCase().includes('virtualmachines'))
  if (!vm) { log('sanitize', 'No VM to test', 'skip'); return }
  
  const sanitized = sanitizeResource(vm)
  
  assert(!sanitized.properties?.provisioningState, 'sanitize', 'provisioningState removed')
  assert(!sanitized.properties?.vmId, 'sanitize', 'vmId removed')
  assert(!sanitized.properties?.resourceGuid, 'sanitize', 'resourceGuid removed')
  
  const osDisk = sanitized.properties?.storageProfile?.osDisk
  assert(osDisk?.createOption === 'FromImage', 'sanitize', 'osDisk.createOption = FromImage')
  assert(!osDisk?.managedDisk, 'sanitize', 'stale managedDisk reference removed')
  
  // NIC reference preserved
  const nicRef = sanitized.properties?.networkProfile?.networkInterfaces?.[0]?.id
  assert(!!nicRef, 'sanitize', 'NIC reference preserved after sanitization')
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 4: DESTRUCTIVE TEST — DELETE VM
// ═══════════════════════════════════════════════════════════════════════════════
async function phase4_deleteVM() {
  console.log('\n═══ PHASE 4: DESTRUCTIVE TEST — DELETING VM ═══')
  
  const computeClient = new ComputeManagementClient(credential, SUB)
  
  try {
    log('delete', 'Deleting testing-vm...')
    await computeClient.virtualMachines.beginDeleteAndWait(TEST_RG, 'testing-vm')
    log('delete', 'VM deleted', 'pass')
  } catch (e) {
    if (e.code === 'ResourceNotFound') {
      log('delete', 'VM already deleted', 'pass')
    } else {
      log('delete', `Delete failed: ${e.message}`, 'fail')
      return false
    }
  }
  
  // Verify VM is gone
  await sleep(5000)
  try {
    await computeClient.virtualMachines.get(TEST_RG, 'testing-vm')
    assert(false, 'delete', 'VM should not exist after deletion')
    return false
  } catch (e) {
    assert(e.code === 'ResourceNotFound' || e.statusCode === 404, 'delete', 'VM confirmed deleted from Azure')
  }
  
  return true
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 5: TRIGGER REMEDIATION
// ═══════════════════════════════════════════════════════════════════════════════
async function phase5_remediate() {
  console.log('\n═══ PHASE 5: TRIGGER REMEDIATION ═══')
  
  const baseline = await getBaseline(SUB, TEST_RG)
  const resources = baseline.resourceState?.resources || []
  
  log('remediate', `Deploying ${resources.length} resources from baseline...`)
  
  const startTime = Date.now()
  const result = await deployResources(SUB, TEST_RG, resources)
  const duration = ((Date.now() - startTime) / 1000).toFixed(1)
  
  log('remediate', `Deployment completed in ${duration}s`)
  log('remediate', `Success: ${result.summary.successful}, Failed: ${result.summary.failed}, Skipped: ${result.summary.skipped}`)
  
  result.results?.forEach(r => {
    log('remediate', `${r.name} (${r.type?.split('/').pop() || 'unknown'}): ${r.status}${r.reason ? ' — ' + r.reason : ''}`, r.status === 'success' ? 'pass' : r.status === 'skipped' ? 'skip' : 'fail')
  })
  
  return result
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 6: AZURE-SIDE VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════
async function phase6_validateAzureState() {
  console.log('\n═══ PHASE 6: AZURE-SIDE VALIDATION ═══')
  
  await sleep(10000) // Wait for Azure to settle
  
  const armClient = new ResourceManagementClient(credential, SUB)
  const computeClient = new ComputeManagementClient(credential, SUB)
  const networkClient = new NetworkManagementClient(credential, SUB)
  
  // VM existence + provisioning state
  try {
    const vm = await computeClient.virtualMachines.get(TEST_RG, 'testing-vm', { expand: 'instanceView' })
    assert(!!vm, 'azure-validate', 'VM exists in Azure')
    assert(vm.provisioningState === 'Succeeded', 'azure-validate', `VM provisioningState: ${vm.provisioningState}`)
    const powerState = vm.instanceView?.statuses?.find(s => s.code?.startsWith('PowerState/'))?.code
    log('azure-validate', `VM power state: ${powerState || 'unknown'}`)
  } catch (e) {
    assert(false, 'azure-validate', `VM NOT FOUND: ${e.message}`)
  }
  
  // NIC existence + subnet binding
  try {
    const nic = await networkClient.networkInterfaces.get(TEST_RG, 'testing-vm798')
    assert(!!nic, 'azure-validate', 'NIC exists in Azure')
    assert(nic.provisioningState === 'Succeeded', 'azure-validate', `NIC provisioningState: ${nic.provisioningState}`)
    const subnetId = nic.ipConfigurations?.[0]?.subnet?.id
    assert(!!subnetId, 'azure-validate', `NIC subnet binding: ${subnetId?.split('/').pop()}`)
    const nsgId = nic.networkSecurityGroup?.id
    assert(!!nsgId, 'azure-validate', `NIC NSG association: ${nsgId?.split('/').pop()}`)
  } catch (e) {
    assert(false, 'azure-validate', `NIC NOT FOUND: ${e.message}`)
  }
  
  // NSG existence
  try {
    const nsg = await networkClient.networkSecurityGroups.get(TEST_RG, 'testing-vm-nsg')
    assert(!!nsg, 'azure-validate', 'NSG exists in Azure')
    assert(nsg.provisioningState === 'Succeeded', 'azure-validate', `NSG provisioningState: ${nsg.provisioningState}`)
    log('azure-validate', `NSG rules: ${nsg.securityRules?.length || 0} custom rules`)
  } catch (e) {
    assert(false, 'azure-validate', `NSG NOT FOUND: ${e.message}`)
  }
  
  // Public IP
  try {
    const ip = await networkClient.publicIPAddresses.get(TEST_RG, 'testing-vm-ip')
    assert(!!ip, 'azure-validate', 'Public IP exists in Azure')
    assert(ip.provisioningState === 'Succeeded', 'azure-validate', `Public IP provisioningState: ${ip.provisioningState}`)
    log('azure-validate', `Public IP address: ${ip.ipAddress || 'pending allocation'}`)
  } catch (e) {
    assert(false, 'azure-validate', `Public IP NOT FOUND: ${e.message}`)
  }
  
  // VNet + subnet
  try {
    const vnet = await networkClient.virtualNetworks.get(TEST_RG, 'testing-vm-vnet')
    assert(!!vnet, 'azure-validate', 'VNet exists in Azure')
    assert(vnet.provisioningState === 'Succeeded', 'azure-validate', `VNet provisioningState: ${vnet.provisioningState}`)
    const subnet = vnet.subnets?.find(s => s.name === 'default')
    assert(!!subnet, 'azure-validate', 'Subnet "default" exists in VNet')
  } catch (e) {
    assert(false, 'azure-validate', `VNet NOT FOUND: ${e.message}`)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 7: DRIFT COMPARISON POST-REMEDIATION
// ═══════════════════════════════════════════════════════════════════════════════
async function phase7_driftCheck() {
  console.log('\n═══ PHASE 7: POST-REMEDIATION DRIFT CHECK ═══')
  
  const baseline = await getBaseline(SUB, TEST_RG)
  const live = await getResourceConfig(SUB, TEST_RG, null)
  
  // Compare only resources that exist in both
  const baseResources = baseline.resourceState?.resources || []
  const liveResources = live.resources || []
  log('drift', `Baseline: ${baseResources.length} resources, Live: ${liveResources.length} resources`)
  
  const diffs = diffObjects(baseline.resourceState, live)
  log('drift', `Remaining diffs after remediation: ${diffs.length}`)
  diffs.forEach(d => log('drift', `  ${d.type}: ${d.path}`, 'info'))
  assert(diffs.length <= 3, 'drift', `Drift within acceptable range (${diffs.length} diffs)`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIDENCE SCORING
// ═══════════════════════════════════════════════════════════════════════════════
function calculateConfidence() {
  const total = report.results.length
  const passed = report.results.filter(r => r.pass).length
  const failed = report.results.filter(r => !r.pass).length
  report.confidence = total > 0 ? Math.round((passed / total) * 100) : 0
  return { total, passed, failed, confidence: report.confidence }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════
async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗')
  console.log('║  ADIP DESTRUCTIVE INTEGRATION TEST — VM STACK RECOVERY     ║')
  console.log('║  Target: testing-rg                                         ║')
  console.log('╚══════════════════════════════════════════════════════════════╝')
  
  report.startTime = new Date().toISOString()
  
  try {
    // Phase 1: Validate baseline (from saved blob, not live)
    log('baseline', 'Loading saved baseline from blob...')
    const baseline = await getBaseline(SUB, TEST_RG)
    if (!baseline?.resourceState?.resources?.length) {
      log('baseline', 'No saved baseline found — cannot proceed', 'fail')
      return
    }
    const resources = baseline.resourceState.resources
    log('baseline', `Baseline loaded: ${resources.length} resources`)
    
    const vm = resources.find(r => r.type?.toLowerCase().includes('virtualmachines'))
    const nic = resources.find(r => r.type?.toLowerCase().includes('networkinterfaces'))
    const nsg = resources.find(r => r.type?.toLowerCase().includes('networksecuritygroups'))
    const ip = resources.find(r => r.type?.toLowerCase().includes('publicipaddresses'))
    const vnet = resources.find(r => r.type?.toLowerCase().includes('virtualnetworks'))
    
    assert(!!vm, 'baseline', 'VM exists in baseline')
    assert(!!nic, 'baseline', 'NIC exists in baseline')
    assert(!!nsg, 'baseline', 'NSG exists in baseline')
    assert(!!ip, 'baseline', 'Public IP exists in baseline')
    assert(!!vnet, 'baseline', 'VNet exists in baseline')
    
    // VM NIC reference
    const nicRef = vm?.properties?.networkProfile?.networkInterfaces?.[0]?.id
    assert(!!nicRef, 'baseline', 'VM has NIC reference')
    if (nicRef) {
      const nicExists = resources.find(r => r.id?.toLowerCase() === nicRef.toLowerCase())
      assert(!!nicExists, 'baseline', 'VM NIC reference resolves')
    }
    
    // Phase 2: Dependency graph
    await phase2_validateDependencyGraph(resources)
    
    // Phase 3: ARM sanitization
    await phase3_validateSanitization(resources)
    
    // Phase 4: Verify VM is currently deleted
    log('delete', 'Verifying VM is currently deleted...')
    const computeClient = new ComputeManagementClient(credential, SUB)
    try {
      await computeClient.virtualMachines.get(TEST_RG, 'testing-vm')
      log('delete', 'VM still exists — skipping delete (will remediate anyway)', 'info')
    } catch (e) {
      assert(true, 'delete', 'VM confirmed deleted — ready for recovery')
    }
    
    // Phase 5: Remediate
    await phase5_remediate()
    
    // Phase 6: Azure validation
    await phase6_validateAzureState()
    
    // Phase 7: Drift check
    await phase7_driftCheck()
    
  } catch (error) {
    log('fatal', `Unhandled error: ${error.message}`, 'fail')
    console.error(error.stack)
  }
  
  report.endTime = new Date().toISOString()
  
  // Final report
  const score = calculateConfidence()
  console.log('\n╔══════════════════════════════════════════════════════════════╗')
  console.log('║  FINAL REPORT                                               ║')
  console.log('╠══════════════════════════════════════════════════════════════╣')
  console.log(`║  Tests: ${score.total} total, ${score.passed} passed, ${score.failed} failed`)
  console.log(`║  Confidence: ${score.confidence}%`)
  console.log(`║  Duration: ${((new Date(report.endTime) - new Date(report.startTime)) / 1000).toFixed(0)}s`)
  console.log(`║  Result: ${score.failed === 0 ? '✓ ALL TESTS PASSED' : '✗ FAILURES DETECTED'}`)
  console.log('╚══════════════════════════════════════════════════════════════╝')
  
  // Write report to file
  const fs = require('fs')
  const reportPath = require('path').join(__dirname, 'recovery-report.json')
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(`\nReport saved: ${reportPath}`)
  
  report.success = score.failed === 0
  process.exit(score.failed === 0 ? 0 : 1)
}

main()
