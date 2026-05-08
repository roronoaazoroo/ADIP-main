// ============================================================
// FILE: adip-backend/express-api/src/routes/baselineValidation.js
// ROLE: Validates baseline completeness + dependency graph before remediation
//
// POST /api/baseline/validate — checks baseline integrity
// POST /api/recovery/test    — runs destructive integration test
// ============================================================
'use strict'
const router = require('express').Router()
const { getBaseline } = require('../services/blobService')
const { getResourceConfig, getApiVersion } = require('../services/azureResourceService')
const { buildDependencyGraph, topologicalSort, getLayer, sanitizeResource } = require('../services/deploymentEngine')
const { ResourceManagementClient } = require('@azure/arm-resources')
const { DefaultAzureCredential } = require('@azure/identity')

const credential = new DefaultAzureCredential()

// POST /api/baseline/validate
router.post('/baseline/validate', async (req, res) => {
  const { subscriptionId, resourceGroupId } = req.body
  if (!subscriptionId || !resourceGroupId) return res.status(400).json({ error: 'subscriptionId and resourceGroupId required' })

  try {
    const baseline = await getBaseline(subscriptionId, resourceGroupId)
    if (!baseline?.resourceState) return res.json({ valid: false, reason: 'No baseline found', recoverable: false })

    const resources = baseline.resourceState.resources || []
    if (!resources.length) return res.json({ valid: false, reason: 'Baseline has no resources', recoverable: false })

    // Check each resource has required fields
    const issues = []
    resources.forEach(r => {
      if (!r.id) issues.push(`${r.name || 'unknown'}: missing id`)
      if (!r.type) issues.push(`${r.name || 'unknown'}: missing type`)
      if (!r.location && !r.type?.includes('schedules')) issues.push(`${r.name || 'unknown'}: missing location`)
    })

    // Build dependency graph and check completeness
    const graph = buildDependencyGraph(resources)
    const sorted = topologicalSort(resources, graph)
    const missingDependencies = []

    // Check VM has NIC
    const vms = resources.filter(r => r.type?.toLowerCase().includes('virtualmachines'))
    vms.forEach(vm => {
      const nics = vm.properties?.networkProfile?.networkInterfaces || []
      nics.forEach(nic => {
        if (nic.id && !resources.find(r => r.id?.toLowerCase() === nic.id.toLowerCase())) {
          missingDependencies.push({ resource: vm.name, missing: nic.id.split('/').pop(), type: 'NIC' })
        }
      })
    })

    // Check NIC has subnet/NSG
    const nicResources = resources.filter(r => r.type?.toLowerCase().includes('networkinterfaces'))
    nicResources.forEach(nic => {
      const ipConfigs = nic.properties?.ipConfigurations || []
      ipConfigs.forEach(ip => {
        const subnetId = ip.properties?.subnet?.id
        if (subnetId) {
          const vnetId = subnetId.split('/subnets/')[0]
          if (!resources.find(r => r.id?.toLowerCase() === vnetId.toLowerCase())) {
            missingDependencies.push({ resource: nic.name, missing: vnetId.split('/').pop(), type: 'VNet' })
          }
        }
      })
    })

    const deploymentLayers = sorted.map(r => ({ name: r.name, type: (r.type || '').split('/').pop(), layer: getLayer(r.type) }))

    const confidence = Math.max(0, 100 - issues.length * 10 - missingDependencies.length * 20)

    res.json({
      valid: issues.length === 0 && missingDependencies.length === 0,
      resourceCount: resources.length,
      issues,
      missingDependencies,
      deploymentLayers,
      recoverable: missingDependencies.length === 0,
      confidence,
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// POST /api/recovery/test — runs full destructive integration test
router.post('/recovery/test', async (req, res) => {
  const { subscriptionId, resourceGroupId } = req.body
  if (!subscriptionId || !resourceGroupId) return res.status(400).json({ error: 'subscriptionId and resourceGroupId required' })

  const timeline = []
  const log = (msg) => { timeline.push({ time: new Date().toISOString(), message: msg }); console.log('[recovery-test]', msg) }

  try {
    const armClient = new ResourceManagementClient(credential, subscriptionId)

    // Step 1: Validate baseline
    log('Step 1: Validating baseline...')
    const baseline = await getBaseline(subscriptionId, resourceGroupId)
    if (!baseline?.resourceState?.resources?.length) {
      return res.json({ success: false, reason: 'No baseline with resources', timeline })
    }
    const baselineResources = baseline.resourceState.resources
    log(`Baseline has ${baselineResources.length} resources`)

    // Step 2: Record current live state
    log('Step 2: Recording current live state...')
    const liveBefore = await getResourceConfig(subscriptionId, resourceGroupId, null)
    log(`Live state: ${liveBefore.resources?.length} resources`)

    // Step 3: Deploy from baseline (remediation)
    log('Step 3: Deploying from baseline (dependency-aware)...')
    const { deployResources } = require('../services/deploymentEngine')
    const deployResult = await deployResources(subscriptionId, resourceGroupId, baselineResources)
    log(`Deployment: ${deployResult.summary.successful} success, ${deployResult.summary.failed} failed, ${deployResult.summary.skipped} skipped`)

    // Step 4: Validate Azure state after deployment
    log('Step 4: Validating Azure state...')
    const liveAfter = await getResourceConfig(subscriptionId, resourceGroupId, null)
    const validationResults = []

    for (const baseResource of baselineResources) {
      const name = baseResource.name
      const liveResource = liveAfter.resources?.find(r => r.name === name)
      if (liveResource) {
        const provState = liveResource.properties?.provisioningState || 'Unknown'
        validationResults.push({ name, type: (baseResource.type || '').split('/').pop(), exists: true, provisioningState: provState, pass: provState === 'Succeeded' })
      } else {
        validationResults.push({ name, type: (baseResource.type || '').split('/').pop(), exists: false, pass: false })
      }
    }

    const passed = validationResults.filter(r => r.pass).length
    const failed = validationResults.filter(r => !r.pass).length

    log(`Validation: ${passed} passed, ${failed} failed`)

    res.json({
      success: failed === 0,
      deployment: deployResult,
      validation: validationResults,
      summary: { total: validationResults.length, passed, failed },
      confidence: Math.round((passed / validationResults.length) * 100),
      timeline,
    })
  } catch (error) {
    log(`ERROR: ${error.message}`)
    res.status(500).json({ success: false, error: error.message, timeline })
  }
})

module.exports = router
