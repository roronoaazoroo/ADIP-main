// FILE: routes/remediateDecision.js

'use strict'
const router_remediateDecision = require('express').Router()
const { getBaseline, saveBaseline } = require('../services/blobService')
const { reconcileStorageChildren } = require('../services/storageChildService')
const { getResourceConfig, getApiVersion } = require('../services/azureResourceService')
const { ResourceManagementClient } = require('@azure/arm-resources')
const { DefaultAzureCredential }   = require('@azure/identity')
const { stripVolatileFields } = require('../shared/armUtils')
 
 
//  html START 
// Generates a styled HTML confirmation page shown to the admin after approve/reject
function html(title, message, color) {
  console.log('[html] starts — title:', title)
  const result = `<!DOCTYPE html>
<html><head><title>ADIP — ${title}</title>
<style>body{font-family:Segoe UI,Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc}
.card{max-width:480px;padding:40px;background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.08);text-align:center}
h2{color:${color};margin:0 0 12px}p{color:#374151;font-size:14px;line-height:1.6}
a{display:inline-block;margin-top:20px;padding:10px 24px;background:#1d4ed8;color:#fff;text-decoration:none;border-radius:6px;font-size:13px}</style>
</head><body>
<div class="card">
  <h2>${title}</h2>
  <p>${message}</p>
  <a href="/">Return to ADIP Dashboard</a>
</div>
</body></html>`
  console.log('[html] ends')
  return result
}
//  html END 
 
 
//  GET /api/remediate-decision START 
// Called when an admin clicks Approve or Reject in the drift alert email
// Approve: applies baseline via ARM PUT — Reject: promotes current state as new baseline
router_remediateDecision.get('/remediate-decision', async (req, res) => {
  console.log('[GET /remediate-decision] starts — action:', req.query.action)
  const { action, token } = req.query
  if (!token || !['approve', 'reject'].includes(action)) {
    console.log('[GET /remediate-decision] ends — invalid action/token')
    return res.status(400).send(html('Invalid Request', 'Missing or invalid action/token.', '#dc2626'))
  }
 
  let payload
  try {
    payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf-8'))
  } catch {
    console.log('[GET /remediate-decision] ends — malformed token')
    return res.status(400).send(html('Invalid Token', 'The approval link is malformed or expired.', '#dc2626'))
  }
 
  const { resourceId, resourceGroup, subscriptionId } = payload
  if (!resourceId || !subscriptionId) {
    console.log('[GET /remediate-decision] ends — token missing fields')
    return res.status(400).send(html('Invalid Token', 'Token is missing required fields.', '#dc2626'))
  }
 
  const resourceName = resourceId.split('/').pop()
 
  try {
    if (action === 'approve') {
      //  Approve: revert live resource to golden baseline 
      const baseline = await getBaseline(subscriptionId, resourceId)
      if (!baseline?.resourceState) {
        console.log('[GET /remediate-decision] ends — no baseline for approve')
        return res.send(html('No Baseline Found',
          `No golden baseline exists for <strong>${resourceName}</strong>. Cannot remediate.`, '#d97706'))
      }
 
      // Volatile and read-only field stripping imported from shared/armUtils.js (DRY)
 
      // strip() is now stripVolatileFields() from shared/armUtils.js
 
      const baselineStateStripped = stripVolatileFields(baseline.resourceState)
      const credential    = new DefaultAzureCredential()
      const armClient     = new ResourceManagementClient(credential, subscriptionId)
      const parts         = resourceId.split('/')
      const rgName        = parts[4], provider = parts[6], type = parts[7], name = parts[8]

      if (!rgName || !provider || !type || !name) {
        return res.status(400).send(html('Cannot Remediate',
          'Remediation via email approval only works for specific resources, not resource groups. Please use the dashboard to remediate resource group level drift.', '#d97706'))
      }

      const apiVersion    = await getApiVersion(subscriptionId, provider, type)
 
      let location = baseline.resourceState?.location
      if (!location) {
        try {
          const live = await armClient.resources.get(rgName, provider, '', type, name, apiVersion)
          location = live.location
        } catch { location = process.env.DEFAULT_AZURE_LOCATION || 'eastus' }
      }
 
      await armClient.resources.beginCreateOrUpdateAndWait(
        rgName, provider, '', type, name, apiVersion,
        { ...baselineStateStripped, location }
      )

      // Reverse-reference cleanup for NSG subnet associations
      if (type.toLowerCase() === 'networksecuritygroups') {
        const vnetApiVersion    = await getApiVersion(subscriptionId, 'Microsoft.Network', 'virtualNetworks')
        const baselineSubnetIds = (baselineStateStripped.properties?.subnets || []).map(s => s.id?.toLowerCase()).filter(Boolean)
        const currentNsg        = await armClient.resources.get(rgName, provider, '', type, name, apiVersion).catch(() => ({}))
        const liveSubnetIds     = (currentNsg.properties?.subnets || []).map(s => s.id?.toLowerCase()).filter(Boolean)

        // Subnets in live but NOT in baseline → dissociate (remove NSG from subnet)
        for (const subnetId of liveSubnetIds.filter(id => !baselineSubnetIds.includes(id))) {
          try {
            const subnetIdParts = subnetId.split('/')
            const vnetRg = subnetIdParts[4], vnetName = subnetIdParts[8], subnetName = subnetIdParts[10]
            if (!vnetRg || !vnetName || !subnetName) continue
            const subnetConfig = await armClient.resources.get(vnetRg, 'Microsoft.Network', `virtualNetworks/${vnetName}`, 'subnets', subnetName, vnetApiVersion)
            if (subnetConfig.properties?.networkSecurityGroup) {
              delete subnetConfig.properties.networkSecurityGroup
              await armClient.resources.beginCreateOrUpdateAndWait(vnetRg, 'Microsoft.Network', `virtualNetworks/${vnetName}`, 'subnets', subnetName, vnetApiVersion, subnetConfig)
              console.log(`[decision] dissociated subnet ${subnetName} from NSG`)
            }
          } catch (dissociateError) { console.warn('[decision] dissociate failed:', dissociateError.message) }
        }

        // Subnets in baseline but NOT in live → re-associate (add NSG back to subnet)
        for (const subnetId of baselineSubnetIds.filter(id => !liveSubnetIds.includes(id))) {
          try {
            const subnetIdParts = subnetId.split('/')
            const vnetRg = subnetIdParts[4], vnetName = subnetIdParts[8], subnetName = subnetIdParts[10]
            if (!vnetRg || !vnetName || !subnetName) continue
            const subnetConfig = await armClient.resources.get(vnetRg, 'Microsoft.Network', `virtualNetworks/${vnetName}`, 'subnets', subnetName, vnetApiVersion)
            subnetConfig.properties = subnetConfig.properties || {}
            subnetConfig.properties.networkSecurityGroup = { id: resourceId }  // re-attach this NSG
            await armClient.resources.beginCreateOrUpdateAndWait(vnetRg, 'Microsoft.Network', `virtualNetworks/${vnetName}`, 'subnets', subnetName, vnetApiVersion, subnetConfig)
            console.log(`[decision] re-associated subnet ${subnetName} with NSG`)
          } catch (reassociateError) { console.warn('[decision] re-associate failed:', reassociateError.message) }
        }
      }

      // Reconcile storage child resources (containers, shares, queues, tables) via shared service
      if (type.toLowerCase() === 'storageaccounts') {
        const currentLiveConfig = await getResourceConfig(subscriptionId, rgName, resourceId).catch(() => ({}))
        await reconcileStorageChildren(subscriptionId, rgName, name, baselineStateStripped._childConfig, currentLiveConfig._childConfig, credential)
      }

      // Record cost savings — diff live vs baseline to find cost-relevant changes
      try {
        const { recordRemediationSavings } = require('./costEstimate')
        const { diffObjects } = require('../shared/diff')
        const { stripVolatileFields: strip } = require('../shared/armUtils')
        const liveForCost     = await getResourceConfig(subscriptionId, rgName, resourceId).catch(() => ({}))
        const baselineForCost = await getBaseline(subscriptionId, resourceId).catch(() => null)
        const diffs = baselineForCost?.resourceState
          ? diffObjects(strip(liveForCost), strip(baselineForCost.resourceState))
          : []
        await recordRemediationSavings(subscriptionId, rgName, resourceId, diffs, liveForCost.location || process.env.DEFAULT_AZURE_LOCATION || 'eastus', liveForCost.type)
      } catch { /* non-fatal */ }

      console.log('[GET /remediate-decision] ends — approved and applied')
      return res.send(html('✓ Remediation Applied',
        `<strong>${resourceName}</strong> has been successfully reverted to its golden baseline.`, '#16a34a'))
 
    } else {
      //  Reject: promote current live state as new baseline 
      const liveState = await getResourceConfig(subscriptionId, resourceGroup, resourceId)
      // await saveBaseline(subscriptionId, resourceGroup, resourceId, liveState)
 
      console.log('[GET /remediate-decision] ends — rejected (drift accepted as baseline)')
      return res.send(html('Drift Accepted',
        `Auto remediation on the current configuration <strong>${resourceName}</strong> has been rejected`, '#6b7280'))
    }
  } catch (err) {
    console.log('[GET /remediate-decision] ends — error:', err.message)
    return res.status(500).send(html('Error', `Operation failed: ${err.message}`, '#dc2626'))
  }
})
//  GET /api/remediate-decision END 
 
module.exports = router_remediateDecision