// ============================================================
// FILE: adip-backend/express-api/src/services/deploymentEngine.js
// ROLE: Dependency-Aware Azure Resource Reconstruction Engine
//
// - Parses ARM snapshots
// - Builds dependency graph
// - Topologically sorts deployment order
// - Sanitizes VM/disk references
// - Deploys layer-by-layer with graceful failure handling
// ============================================================
'use strict'
const { ResourceManagementClient } = require('@azure/arm-resources')
const { DefaultAzureCredential } = require('@azure/identity')
const { getApiVersion } = require('./azureResourceService')
const { stripVolatileFields } = require('../shared/armUtils')

const credential = new DefaultAzureCredential()
const { trackDeployment, trackArmCall } = require('../shared/telemetry')

// ── Feature Flags ─────────────────────────────────────────────────────────────
const FLAGS = {
  enableAutoRemediation: process.env.ENABLE_AUTO_REMEDIATION !== 'false',
  enableAIRecovery: process.env.ENABLE_AI_RECOVERY !== 'false',
  maxRetries: parseInt(process.env.REMEDIATION_MAX_RETRIES || '2', 10),
}

// ── Audit Logger ─────────────────────────────────────────────────────────────
const auditLog = []
function audit(action, resource, status, detail = '') {
  const entry = { timestamp: new Date().toISOString(), action, resource, status, detail }
  auditLog.push(entry)
  console.log(`[audit] ${action} ${resource} — ${status}${detail ? ': ' + detail : ''}`)
}
function getAuditLog() { return auditLog.slice(-100) }


// ── Deployment Layer Priority ────────────────────────────────────────────────
const LAYER_MAP = {
  'networksecuritygroups': 1, 'publicipaddresses': 1, 'routetables': 1, 'userAssignedIdentities': 1,
  'virtualnetworks': 2, 'storageaccounts': 2, 'serverfarms': 2, 'availabilitysets': 2, 'natgateways': 2,
  'networkinterfaces': 3, 'loadbalancers': 3,
  'disks': 4, 'snapshots': 4,
  'virtualmachines': 5, 'virtualmachinescalesets': 5,
}

function getLayer(type) {
  const shortType = (type || '').split('/').pop()?.toLowerCase() || ''
  return LAYER_MAP[shortType] || 3
}

// ── ARM Sanitizer ────────────────────────────────────────────────────────────
const STALE_FIELDS = ['provisioningState', 'vmId', 'resourceGuid', 'timeCreated', 'instanceView', 'powerState', 'statuses', 'uniqueId']

function sanitizeResource(resource) {
  // Custom sanitization that preserves id references (needed for NIC/subnet bindings)
  const REMOVE_TOP = ['etag', 'changedTime', 'createdTime', 'lastModifiedAt', 'systemData', '_ts', '_etag', '_rid', '_self', '_childConfig']
  const REMOVE_PROPS = ['provisioningState', 'vmId', 'resourceGuid', 'timeCreated', 'instanceView', 'powerState', 'statuses', 'uniqueId']
  const cleaned = JSON.parse(JSON.stringify(resource))
  REMOVE_TOP.forEach(f => delete cleaned[f])
  if (cleaned.properties) REMOVE_PROPS.forEach(f => delete cleaned.properties[f])
  const type = (resource.type || '').toLowerCase()

  // VM-specific sanitization
  if (type.includes('virtualmachines')) {
    if (cleaned.properties?.osProfile) {
      delete cleaned.properties.osProfile.requireGuestProvisionSignal
    }
    if (cleaned.properties?.storageProfile?.osDisk) {
      const osDisk = cleaned.properties.storageProfile.osDisk
      osDisk.createOption = 'FromImage'
      delete osDisk.managedDisk
      delete osDisk.name
      // Remove data disk stale refs
      if (cleaned.properties.storageProfile.dataDisks) {
        cleaned.properties.storageProfile.dataDisks.forEach(d => {
          d.createOption = 'Empty'
          delete d.managedDisk
        })
      }
    }
  }

  // Remove stale fields from properties
  if (cleaned.properties) {
    STALE_FIELDS.forEach(f => delete cleaned.properties[f])
  }

  return cleaned
}

// ── Dependency Graph Builder ─────────────────────────────────────────────────
function buildDependencyGraph(resources) {
  const graph = {} // resourceId → [dependsOn resourceIds]
  const idMap = {} // lowercase id → resource

  resources.forEach(r => {
    if (r.id) idMap[r.id.toLowerCase()] = r
    graph[r.id?.toLowerCase() || r.name] = []
  })

  resources.forEach(r => {
    const deps = extractDependencies(r)
    const key = r.id?.toLowerCase() || r.name
    deps.forEach(depId => {
      if (idMap[depId.toLowerCase()]) {
        graph[key].push(depId.toLowerCase())
      }
    })
  })

  return graph
}

function extractDependencies(resource) {
  const deps = []
  const props = resource.properties || {}
  const type = (resource.type || '').toLowerCase()

  // NIC → subnet, NSG, public IP
  if (type.includes('networkinterfaces')) {
    (props.ipConfigurations || []).forEach(ip => {
      if (ip.properties?.subnet?.id) deps.push(ip.properties.subnet.id)
      if (ip.properties?.publicIPAddress?.id) deps.push(ip.properties.publicIPAddress.id)
    })
    if (props.networkSecurityGroup?.id) deps.push(props.networkSecurityGroup.id)
  }
  // VM → NIC, disk
  if (type.includes('virtualmachines')) {
    (props.networkProfile?.networkInterfaces || []).forEach(nic => {
      if (nic.id) deps.push(nic.id)
    })
  }
  // Subnet → NSG, route table
  if (type.includes('virtualnetworks')) {
    (props.subnets || []).forEach(s => {
      if (s.properties?.networkSecurityGroup?.id) deps.push(s.properties.networkSecurityGroup.id)
      if (s.properties?.routeTable?.id) deps.push(s.properties.routeTable.id)
    })
  }
  // Web App → App Service Plan
  if (type.includes('sites')) {
    if (props.serverFarmId) deps.push(props.serverFarmId)
  }

  return deps
}

// ── Topological Sort ─────────────────────────────────────────────────────────
function topologicalSort(resources, graph) {
  // First sort by layer, then by dependency within layer
  const sorted = [...resources].sort((a, b) => {
    const layerA = getLayer(a.type)
    const layerB = getLayer(b.type)
    if (layerA !== layerB) return layerA - layerB
    // Within same layer, check if one depends on the other
    const aKey = a.id?.toLowerCase() || a.name
    const bKey = b.id?.toLowerCase() || b.name
    if (graph[aKey]?.includes(bKey)) return 1
    if (graph[bKey]?.includes(aKey)) return -1
    return 0
  })
  return sorted
}

// ── Deployment Orchestrator ──────────────────────────────────────────────────
async function deployResources(subscriptionId, resourceGroupId, resources, options = {}) {
  const _startTime = Date.now()
  console.log('[deploymentEngine] starts — resources:', resources.length)

  const graph = buildDependencyGraph(resources)
  const sorted = topologicalSort(resources, graph)

  const results = []
  const failed = new Set() // track failed resource IDs
  const armClient = new ResourceManagementClient(credential, subscriptionId)

  for (const resource of sorted) {
    const resourceKey = resource.id?.toLowerCase() || resource.name
    const parts = resource.id?.split('/') || []
    const provider = parts[6]
    const type = parts[7]
    const name = parts[8] || resource.name

    // Skip standalone managed disks — VM creates its own disk with FromImage
    if (type?.toLowerCase() === 'disks') {
      results.push({ name, type: resource.type, status: 'skipped', reason: 'Managed disk recreated automatically by VM deployment' })
      audit('skip', name, 'disk', 'VM will create new disk from image')
      continue
    }

    if (!provider || !type || !name) {
      results.push({ name: resource.name || 'unknown', type: resource.type || '', status: 'skipped', reason: 'Invalid resource ID format' })
      continue
    }

    // Check if any dependency failed
    const deps = graph[resourceKey] || []
    const blockedBy = deps.find(d => failed.has(d))
    if (blockedBy) {
      const blockedName = blockedBy.split('/').pop()
      results.push({ name, type: resource.type, status: 'skipped', reason: `Dependency failure: ${blockedName}` })
      failed.add(resourceKey)
      continue
    }

    // Sanitize and deploy
    try {
      const sanitized = sanitizeResource(resource)
      const apiVersion = await getApiVersion(subscriptionId, provider, type)

      // Retry logic
      let lastError = null
      for (let attempt = 1; attempt <= FLAGS.maxRetries; attempt++) {
        try {
          if (options?.dryRun) {
            results.push({ name, type: resource.type, status: 'dry-run', layer: getLayer(resource.type) })
            audit('dry-run', name, 'planned')
            lastError = null
            break
          }
          await armClient.resources.beginCreateOrUpdateAndWait(
            resourceGroupId, provider, '', type, name, apiVersion,
            { location: sanitized.location, properties: sanitized.properties, tags: sanitized.tags, sku: sanitized.sku, kind: sanitized.kind, identity: sanitized.identity }
          )
          results.push({ name, type: resource.type, status: 'success' })
          audit('deploy', name, 'success')
          lastError = null
          break
        } catch (err) {
          lastError = err
          if (attempt < FLAGS.maxRetries) {
            console.log(`[deploymentEngine] retry ${attempt}/${FLAGS.maxRetries} for ${name}`)
            await new Promise(r => setTimeout(r, 2000 * attempt))
          }
        }
      }
      if (lastError) {
        results.push({ name, type: resource.type, status: 'failed', reason: lastError.message?.slice(0, 150) })
        failed.add(resourceKey)
        audit('deploy', name, 'failed', lastError.message?.slice(0, 100))
      }
    } catch (error) {
      results.push({ name, type: resource.type, status: 'failed', reason: error.message?.slice(0, 150) })
      failed.add(resourceKey)
      audit('deploy', name, 'error', error.message?.slice(0, 100))
    }
  }

  const summary = {
    successful: results.filter(r => r.status === 'success').length,
    failed: results.filter(r => r.status === 'failed').length,
    skipped: results.filter(r => r.status === 'skipped').length,
  }

  trackDeployment({ subscriptionId, resourceGroup: resourceGroupId, resources: resources.length, successful: results.filter(r => r.status === 'success').length, failed: results.filter(r => r.status === 'failed').length, skipped: results.filter(r => r.status === 'skipped').length, duration: Date.now() - _startTime })
  console.log('[deploymentEngine] ends — success:', summary.successful, 'failed:', summary.failed, 'skipped:', summary.skipped)
  return { deploymentId: `deploy-${Date.now()}`, status: summary.failed === 0 && summary.skipped === 0 ? 'success' : 'partial_success', resources: results, summary }
}

module.exports = { deployResources, sanitizeResource, buildDependencyGraph, topologicalSort, getLayer, getAuditLog, FLAGS }
