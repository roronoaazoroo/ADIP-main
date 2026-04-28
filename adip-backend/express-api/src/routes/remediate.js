'use strict'
// FILE: routes/remediate.js

const router_remediate = require('express').Router()
const fetch = require('node-fetch')
const { ResourceManagementClient } = require('@azure/arm-resources')
const { DefaultAzureCredential } = require('@azure/identity')
const { getBaseline } = require('../services/blobService')
const { sendDriftAlertEmail } = require('../services/alertService')
const { reconcileStorageChildren } = require('../services/storageChildService')
const { getResourceConfig, getApiVersion } = require('../services/azureResourceService')
const { diffObjects } = require('../shared/diff')
const { classifySeverity } = require('../shared/severity')
const { stripVolatileFields } = require('../shared/armUtils')
 
// Volatile and read-only field stripping imported from shared/armUtils.js (DRY)
// Additional read-only fields ARM rejects on PUT (VM instanceView, power state, etc.)
 
 
// strip() is now stripVolatileFields() from shared/armUtils.js
 
 
// ── POST /api/remediate START ────────────────────────────────────────────────
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
 
    const baselineState = strip(baseline.resourceState)
    const liveRaw       = await getResourceConfig(subscriptionId, resourceGroupId, resourceId)
    const liveState     = strip(liveRaw)
    const differences   = diffObjects(liveState, baselineState)
 
    const remSeverity = classifySeverity(differences)
    // Send alert email if severity is critical or high (sendDriftAlertEmail handles the severity check)
    sendDriftAlertEmail({ resourceId, resourceGroup: resourceGroupId, subscriptionId, severity: remSeverity, changeCount: differences.length, detectedAt: new Date().toISOString() }).catch(() => {})
 
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
              vnetRg, 'Microsoft.Network', `virtualNetworks/${vnetName}`, 'subnets', subnetName, vnetApi, strip(subnetConfig)
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
            vnetRg, 'Microsoft.Network', `virtualNetworks/${vnetName}`, 'subnets', subnetName, vnetApi, strip(subnetConfig)
          )
          console.log(`[remediate] re-associated subnet ${subnetName} with NSG ${name}`)
        } catch (reassociateError) {
          console.warn(`[remediate] failed to re-associate subnet:`, reassociateError.message)
        }
      }
    }
 
    res.json({ remediated: true, resourceId, changeCount: differences.length,
      appliedBaseline: baselineState, previousLiveState: liveState })
    console.log('[POST /remediate] ends — applied baseline, changes:', differences.length)
  } catch (remediateError) {
    console.log('[POST /remediate] ends — error:', remediateError.message)
    res.status(500).json({ error: remediateError.message })
  }
})
// ── POST /api/remediate END ──────────────────────────────────────────────────
 
module.exports = router_remediate
 
 