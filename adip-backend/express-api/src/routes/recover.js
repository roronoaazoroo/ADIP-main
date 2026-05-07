// ============================================================
// FILE: adip-backend/express-api/src/routes/recover.js
// ROLE: Recover deleted Azure resources from genome snapshots
//
// POST /api/recover/analyze  — analyzes dependencies, returns recovery plan
// POST /api/recover/execute  — executes recovery (ARM PUT in dependency order)
// ============================================================
'use strict'
const router = require('express').Router()
const { ResourceManagementClient } = require('@azure/arm-resources')
const { DefaultAzureCredential } = require('@azure/identity')
const { readBlob } = require('../services/blobService')

const credential = new DefaultAzureCredential()

// Parses ARM resource references from a snapshot's properties
function extractDependencies(resourceState) {
  const dependencies = []
  const props = resourceState?.properties || {}
  const type = (resourceState?.type || '').toLowerCase()

  // VM → NIC, OS Disk
  if (type === 'microsoft.compute/virtualmachines') {
    for (const nic of props.networkProfile?.networkInterfaces || []) {
      if (nic.id) dependencies.push({ resourceId: nic.id, type: 'microsoft.network/networkinterfaces', required: true })
    }
    if (props.storageProfile?.osDisk?.managedDisk?.id) {
      dependencies.push({ resourceId: props.storageProfile.osDisk.managedDisk.id, type: 'microsoft.compute/disks', required: false })
    }
  }
  // NIC → Subnet, NSG, Public IP
  if (type === 'microsoft.network/networkinterfaces') {
    for (const ipConfig of props.ipConfigurations || []) {
      const p = ipConfig.properties || {}
      if (p.subnet?.id) dependencies.push({ resourceId: p.subnet.id, type: 'microsoft.network/virtualnetworks/subnets', required: true })
      if (p.publicIPAddress?.id) dependencies.push({ resourceId: p.publicIPAddress.id, type: 'microsoft.network/publicipaddresses', required: false })
    }
    if (props.networkSecurityGroup?.id) {
      dependencies.push({ resourceId: props.networkSecurityGroup.id, type: 'microsoft.network/networksecuritygroups', required: true })
    }
  }
  // Web App → App Service Plan
  if (type === 'microsoft.web/sites') {
    if (props.serverFarmId) dependencies.push({ resourceId: props.serverFarmId, type: 'microsoft.web/serverfarms', required: true })
  }

  return dependencies
}

// Checks if a resource exists in Azure
async function resourceExists(subscriptionId, resourceId) {
  try {
    const client = new ResourceManagementClient(credential, subscriptionId)
    const parts = resourceId.split('/')
    const resourceGroup = parts[4]
    const provider = parts[6]
    const resourceType = parts[7]
    const resourceName = parts[8]
    await client.resources.get(resourceGroup, provider, '', resourceType, resourceName, '2023-01-01')
    return true
  } catch (error) {
    if (error.statusCode === 404) return false
    return true // assume exists if we can't check
  }
}

// POST /api/recover/analyze
// Body: { subscriptionId, resourceId, blobKey }
// Returns: { resourceName, dependencies: [{ resourceId, name, type, exists, required }], warnings }
router.post('/recover/analyze', async (req, res) => {
  console.log('[POST /recover/analyze] starts')
  const { subscriptionId, resourceId, blobKey } = req.body

  if (!subscriptionId || !blobKey) {
    return res.status(400).json({ error: 'subscriptionId and blobKey required' })
  }

  try {
    const snapshot = await readBlob('baseline-genome', blobKey)
    if (!snapshot?.resourceState) {
      return res.status(404).json({ error: 'Snapshot not found or has no resource state' })
    }

    const resourceState = snapshot.resourceState
    const resourceName = resourceState.name || resourceId?.split('/').pop() || 'unknown'
    const dependencies = extractDependencies(resourceState)

    // Check which dependencies exist
    const dependencyStatus = await Promise.all(
      dependencies.map(async (dep) => {
        const exists = await resourceExists(subscriptionId, dep.resourceId)
        return {
          resourceId: dep.resourceId,
          name: dep.resourceId.split('/').pop(),
          type: dep.type.split('/').pop(),
          exists,
          required: dep.required,
        }
      })
    )

    const missingDependencies = dependencyStatus.filter(d => !d.exists && d.required)
    const existingDependencies = dependencyStatus.filter(d => d.exists)

    const warnings = [
      'This recreates the resource configuration. Data inside the resource (blobs, database rows, VM disks) is NOT recovered.',
    ]
    if (resourceState.identity) {
      warnings.push('This resource had managed identity assignments that may need manual re-configuration.')
    }

    res.json({
      resourceName,
      resourceType: resourceState.type,
      location: resourceState.location,
      missingDependencies,
      existingDependencies,
      warnings,
      canRecover: missingDependencies.length === 0,
    })
    console.log('[POST /recover/analyze] ends — missing deps:', missingDependencies.length)
  } catch (error) {
    console.log('[POST /recover/analyze] error:', error.message)
    res.status(500).json({ error: error.message })
  }
})

// POST /api/recover/execute
// Body: { subscriptionId, resourceGroupId, resourceId, blobKey }
// Recreates the resource from the genome snapshot via ARM PUT
router.post('/recover/execute', async (req, res) => {
  console.log('[POST /recover/execute] starts')
  const { subscriptionId, resourceGroupId, resourceId, blobKey } = req.body

  if (!subscriptionId || !resourceGroupId || !resourceId || !blobKey) {
    return res.status(400).json({ error: 'subscriptionId, resourceGroupId, resourceId, blobKey required' })
  }

  try {
    const snapshot = await readBlob('baseline-genome', blobKey)
    if (!snapshot?.resourceState) {
      return res.status(404).json({ error: 'Snapshot not found' })
    }

    const resourceState = snapshot.resourceState
    const parts = resourceId.split('/')
    const provider = parts[6]
    const resourceType = parts[7]
    const resourceName = parts[8]

    const client = new ResourceManagementClient(credential, subscriptionId)

    // Get API version for this resource type
    const providerInfo = await client.providers.get(provider)
    const typeInfo = providerInfo.resourceTypes?.find(t => t.resourceType?.toLowerCase() === resourceType.toLowerCase())
    const apiVersion = typeInfo?.defaultApiVersion || typeInfo?.apiVersions?.[0] || '2023-01-01'

    // ARM PUT to recreate
    const result = await client.resources.beginCreateOrUpdateAndWait(
      resourceGroupId,
      provider,
      '',
      resourceType,
      resourceName,
      apiVersion,
      {
        location: resourceState.location,
        kind: resourceState.kind,
        sku: resourceState.sku,
        properties: resourceState.properties,
        tags: resourceState.tags,
        identity: resourceState.identity,
      }
    )

    res.json({ recovered: true, resourceId, resourceName, provisioningState: result.provisioningState || 'Succeeded' })
    console.log('[POST /recover/execute] ends — recovered:', resourceName)
  } catch (error) {
    console.log('[POST /recover/execute] error:', error.message)
    res.status(500).json({ error: error.message })
  }
})

module.exports = router
