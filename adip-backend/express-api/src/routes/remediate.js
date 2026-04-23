// FILE: routes/remediate.js

const router_remediate = require('express').Router()
const fetch = require('node-fetch')
const { ResourceManagementClient } = require('@azure/arm-resources')
const { DefaultAzureCredential } = require('@azure/identity')
const { getBaseline } = require('../services/blobService')
const { sendDriftAlertEmail } = require('../services/alertService')
const { getResourceConfig, getApiVersion } = require('../services/azureResourceService')
const { diffObjects } = require('../shared/diff')
 
const VOLATILE_REM = ['etag', 'changedTime', 'createdTime', 'provisioningState', 'lastModifiedAt', 'systemData', '_ts', '_etag', '_rid', '_self', 'id']
// Additional read-only fields ARM rejects on PUT
const READONLY_PROPERTIES_REM = [
  'instanceView', 'powerState', 'statuses', 'resources', 'latestModelApplied', 'vmId', 'timeCreated',
  // NSG read-only fields
  'defaultSecurityRules', 'resourceGuid', 'networkInterfaces', 'subnets',
]
// Additional read-only fields ARM rejects on PUT (VM instanceView, power state, etc.)
 
 
// ── strip (remediate) START ──────────────────────────────────────────────────
// Strips volatile fields before applying an ARM PUT to prevent write conflicts
function strip(obj) {
  console.log('[remediate.strip] starts')
  if (Array.isArray(obj)) {
    const r = obj.map(strip)
    console.log('[remediate.strip] ends — array')
    return r
  }
  if (obj && typeof obj === 'object') {
    const r = Object.fromEntries(
      Object.entries(obj).filter(([k]) => !VOLATILE_REM.includes(k) && !READONLY_PROPERTIES_REM.includes(k)).map(([k, v]) => [k, strip(v)])
    )
    console.log('[remediate.strip] ends — object')
    return r
  }
  console.log('[remediate.strip] ends — primitive')
  return obj
}
// ── strip (remediate) END ────────────────────────────────────────────────────
 
 
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
 
    const { classifySeverity } = require('../shared/severity')
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
      try { location = liveRaw.location } catch { location = 'westus2' }
    }
 
    await armClient.resources.beginCreateOrUpdateAndWait(
      rgName, provider, '', type, name, apiVersion,
      { ...baselineState, location }
    )

    // ── Storage account child resource reconciliation ─────────────────────────
    // ARM PUT on the storage account itself does not create/delete containers, shares,
    // queues, or tables — these are child resources managed via separate ARM endpoints.
    // We compare baseline._childConfig vs live._childConfig and reconcile the difference.
    if (type.toLowerCase() === 'storageaccounts') {
      const armBearerToken = await credential.getToken('https://management.azure.com/.default')

      // Helper: call ARM REST API for storage child resource operations
      async function callStorageChildApi(httpMethod, childResourcePath, requestBody = null) {
        const armUrl = `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${rgName}/providers/Microsoft.Storage/storageAccounts/${name}/${childResourcePath}?api-version=2023-01-01`
        const fetchOptions = {
          method: httpMethod,
          headers: { 'Authorization': `Bearer ${armBearerToken.token}`, 'Content-Type': 'application/json' },
        }
        if (requestBody) fetchOptions.body = JSON.stringify(requestBody)
        const httpResponse = await fetch(armUrl, fetchOptions)
        if (!httpResponse.ok) {
          const errorText = await httpResponse.text()
          throw new Error(`Storage child API error ${httpResponse.status}: ${errorText}`)
        }
        return httpResponse
      }

      // Helper: reconcile one type of child resource (containers, shares, queues, or tables)
      async function reconcileStorageChildResources(childResourceType, serviceBasePath, createBody) {
        const baselineItems = (baselineState._childConfig?.[childResourceType] || []).map(item => item.name.toLowerCase())
        const liveItems     = (liveState._childConfig?.[childResourceType]     || []).map(item => item.name.toLowerCase())

        // Items in live but NOT in baseline → delete them
        const itemsToDelete = liveItems.filter(itemName => !baselineItems.includes(itemName))
        for (const itemName of itemsToDelete) {
          try {
            await callStorageChildApi('DELETE', `${serviceBasePath}/${itemName}`)
            console.log(`[remediate] deleted ${childResourceType} item: ${itemName}`)
          } catch (deleteError) {
            console.warn(`[remediate] failed to delete ${childResourceType} item ${itemName}:`, deleteError.message)
          }
        }

        // Items in baseline but NOT in live → create them
        const itemsToCreate = baselineItems.filter(itemName => !liveItems.includes(itemName))
        for (const itemName of itemsToCreate) {
          try {
            await callStorageChildApi('PUT', `${serviceBasePath}/${itemName}`, createBody)
            console.log(`[remediate] created ${childResourceType} item: ${itemName}`)
          } catch (createError) {
            console.warn(`[remediate] failed to create ${childResourceType} item ${itemName}:`, createError.message)
          }
        }
      }

      await Promise.allSettled([
        reconcileStorageChildResources('blobContainers',  'blobServices/default/containers',  { properties: {} }),
        reconcileStorageChildResources('fileShares',      'fileServices/default/shares',       { properties: {} }),
        reconcileStorageChildResources('storageQueues',   'queueServices/default/queues',      {}),
        reconcileStorageChildResources('storageTables',   'tableServices/default/tables',      {}),
      ])
    }
    // ── Storage account child resource reconciliation END ─────────────────────
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
  } catch (err) {
    console.log('[POST /remediate] ends — error:', err.message)
    res.status(500).json({ error: err.message })
  }
})
// ── POST /api/remediate END ──────────────────────────────────────────────────
 
module.exports = router_remediate
 
 