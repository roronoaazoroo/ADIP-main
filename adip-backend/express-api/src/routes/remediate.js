// FILE: routes/remediate.js

'use strict'
const router_remediate = require('express').Router()
const fetch = require('node-fetch')
const { ResourceManagementClient } = require('@azure/arm-resources')
const { DefaultAzureCredential } = require('@azure/identity')
const { getBaseline } = require('../services/blobService')
const { reconcileStorageChildren } = require('../services/storageChildService')
const { enforcePolicesForDrift }   = require('../services/policyEnforcementService')
const { recordRemediationSavings } = require('./costEstimate')
const { getResourceConfig, getApiVersion } = require('../services/azureResourceService')
const { diffObjects } = require('../shared/diff')
const { classifySeverity } = require('../shared/severity')
const { stripVolatileFields } = require('../shared/armUtils')
 
// Volatile and read-only field stripping imported from shared/armUtils.js (DRY)
// Additional read-only fields ARM rejects on PUT (VM instanceView, power state, etc.)
 
 
// stripVolatileFields() is now stripVolatileFields() from shared/armUtils.js
 
 
//  POST /api/remediate START 
// Immediately reverts a resource to its golden baseline via ARM PUT (used for low severity)
router_remediate.post('/remediate', async (req, res) => {
  console.log('[POST /remediate] starts')
  const { subscriptionId, resourceGroupId, resourceId } = req.body
  if (!subscriptionId || !resourceGroupId || !resourceId) {
    console.log('[POST /remediate] ends — missing required fields')
    return res.status(400).json({ error: 'subscriptionId, resourceGroupId and resourceId required' })
  }
 
  try {
    const baseline = await getBaseline(subscriptionId, resourceId)
    if (!baseline?.resourceState) {
      console.log('[POST /remediate] ends — no baseline found')
      return res.status(404).json({ error: 'No golden baseline found for this resource' })
    }
 
    const baselineState = stripVolatileFields(baseline.resourceState)
    const liveRaw       = await getResourceConfig(subscriptionId, resourceGroupId, resourceId)
    const liveState     = stripVolatileFields(liveRaw)
    const differences   = diffObjects(liveState, baselineState)
 
    const remSeverity = classifySeverity(differences)
    // No alert email during remediation — user is actively fixing the drift
 
    const credential = new DefaultAzureCredential()
    const armClient  = new ResourceManagementClient(credential, subscriptionId)
    const parts      = resourceId.split('/')
    const provider   = parts[6]
    const type       = parts[7]
    const name       = parts[8]
    const rgName     = parts[4]
    const apiVersion = await getApiVersion(subscriptionId, provider, type)
 
    let location = baseline.resourceState?.location
    if (!location) {
      try { location = liveRaw.location } catch { location = process.env.DEFAULT_AZURE_LOCATION || 'eastus' }
    }
 
    await armClient.resources.beginCreateOrUpdateAndWait(
      rgName, provider, '', type, name, apiVersion,
      { ...baselineState, location }
    )

    // Reconcile storage child resources (containers, shares, queues, tables) via shared service
    if (type.toLowerCase() === 'storageaccounts') {
      await reconcileStorageChildren(subscriptionId, rgName, name, baselineState._childConfig, liveState._childConfig, credential)
    }
    if (type.toLowerCase() === 'networksecuritygroups') {
      const vnetApi = await getApiVersion(subscriptionId, 'Microsoft.Network', 'virtualNetworks')
      const baselineSubnetIds = (baselineState.properties?.subnets || []).map(s => s.id?.toLowerCase()).filter(Boolean)
      const liveSubnetIds     = (liveState.properties?.subnets    || []).map(s => s.id?.toLowerCase()).filter(Boolean)

      // Subnets in live but NOT in baseline → dissociate (remove NSG from subnet)
      const subnetsToDisassociate = liveSubnetIds.filter(id => !baselineSubnetIds.includes(id))
      for (const subnetId of subnetsToDisassociate) {
        try {
          const subnetIdParts = subnetId.split('/')
          const vnetRg = subnetIdParts[4], vnetName = subnetIdParts[8], subnetName = subnetIdParts[10]
          if (!vnetRg || !vnetName || !subnetName) continue
          const subnetConfig = await armClient.resources.get(vnetRg, 'Microsoft.Network', `virtualNetworks/${vnetName}`, 'subnets', subnetName, vnetApi)
          if (subnetConfig.properties?.networkSecurityGroup) {
            delete subnetConfig.properties.networkSecurityGroup
            await armClient.resources.beginCreateOrUpdateAndWait(
              vnetRg, 'Microsoft.Network', `virtualNetworks/${vnetName}`, 'subnets', subnetName, vnetApi, stripVolatileFields(subnetConfig)
            )
            console.log(`[remediate] dissociated subnet ${subnetName} from NSG ${name}`)
          }
        } catch (dissociateError) {
          console.warn(`[remediate] failed to dissociate subnet:`, dissociateError.message)
        }
      }

      // Subnets in baseline but NOT in live → re-associate (add NSG back to subnet)
      const subnetsToReassociate = baselineSubnetIds.filter(id => !liveSubnetIds.includes(id))
      for (const subnetId of subnetsToReassociate) {
        try {
          const subnetIdParts = subnetId.split('/')
          const vnetRg = subnetIdParts[4], vnetName = subnetIdParts[8], subnetName = subnetIdParts[10]
          if (!vnetRg || !vnetName || !subnetName) continue
          const subnetConfig = await armClient.resources.get(vnetRg, 'Microsoft.Network', `virtualNetworks/${vnetName}`, 'subnets', subnetName, vnetApi)
          subnetConfig.properties = subnetConfig.properties || {}
          subnetConfig.properties.networkSecurityGroup = { id: resourceId }  // re-attach this NSG
          await armClient.resources.beginCreateOrUpdateAndWait(
            vnetRg, 'Microsoft.Network', `virtualNetworks/${vnetName}`, 'subnets', subnetName, vnetApi, stripVolatileFields(subnetConfig)
          )
          console.log(`[remediate] re-associated subnet ${subnetName} with NSG ${name}`)
        } catch (reassociateError) {
          console.warn(`[remediate] failed to re-associate subnet:`, reassociateError.message)
        }
      }
    }
 
    const policiesCreated = await enforcePolicesForDrift(subscriptionId, rgName, differences).catch(e => {
      console.log('[POST /remediate] policy enforcement non-fatal error:', e.message)
      return []
    })

    // Record cost savings for Feature B
    const monthlySavings = await recordRemediationSavings(subscriptionId, rgName, resourceId, differences, liveRaw?.location || process.env.DEFAULT_AZURE_LOCATION || 'eastus', liveRaw?.type).catch(() => 0)

    res.json({ remediated: true, resourceId, changeCount: differences.length,
      policiesCreated, monthlySavings, appliedBaseline: baselineState, previousLiveState: liveState })
    console.log('[POST /remediate] ends — applied baseline, changes:', differences.length)
  } catch (remediateError) {
    console.log('[POST /remediate] ends — error:', remediateError.message)
    res.status(500).json({ error: remediateError.message })
  }
})
//  POST /api/remediate END 
 

// GET /api/policy/assignments?subscriptionId=&resourceGroupId=
router_remediate.get('/policy/assignments', async (req, res) => {
  console.log('[GET /policy/assignments] starts')
  const { subscriptionId, resourceGroupId } = req.query
  if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' })
  try {
    const { TableClient } = require('@azure/data-tables')
    const tc = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'policyAssignments')
    const items = []
    let filter = `PartitionKey eq '${subscriptionId}'`
    if (resourceGroupId) filter += ` and resourceGroupId eq '${resourceGroupId}'`
    for await (const entity of tc.listEntities({ queryOptions: { filter } })) {
      items.push({ assignmentId: entity.assignmentId, displayName: entity.displayName, resourceGroupId: entity.resourceGroupId, createdAt: entity.createdAt })
    }
    res.json(items)
    console.log('[GET /policy/assignments] ends — count:', items.length)
  } catch (err) {
    console.log('[GET /policy/assignments] error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router_remediate
 
 