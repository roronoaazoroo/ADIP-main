// ============================================================
// FILE: adip-backend/express-api/src/services/dependencyGraphService.js
// ROLE: Builds a dependency graph for all resources in a resource group.
//
// 1. Lists all resources in the RG via ARM SDK
// 2. Fetches full properties for each resource (to extract relationship refs)
// 3. Parses known relationship patterns from resource properties
// 4. Overlays drift status from driftIndex Table (last 7 days)
// 5. Returns { nodes[], links[] } ready for react-force-graph-2d
// ============================================================
'use strict'
const { getResourceConfig }       = require('./azureResourceService')
const { getDriftIndexTableClient } = require('./blobService')

// Color per resource type family
const TYPE_COLOR = {
  'microsoft.network/virtualnetworks':          '#1995ff',
  'microsoft.network/virtualnetworks/subnets':  '#06b6d4',
  'microsoft.network/networksecuritygroups':    '#f97316',
  'microsoft.network/networkinterfaces':        '#8b5cf6',
  'microsoft.network/publicipaddresses':        '#06b6d4',
  'microsoft.compute/virtualmachines':          '#f97316',
  'microsoft.compute/disks':                    '#94a3b8',
  'microsoft.storage/storageaccounts':          '#10b981',
  'microsoft.web/sites':                        '#f59e0b',
  'microsoft.logic/workflows':                  '#a78bfa',
  'microsoft.eventgrid/topics':                 '#ec4899',
  'microsoft.insights/components':              '#64748b',
}

function nodeColor(type) {
  return TYPE_COLOR[type?.toLowerCase()] || '#64748b'
}

// Extracts outbound resource ID references from a resource's properties
function parseReferences(resource) {
  const refs = []
  const props = resource.properties || {}
  const type  = (resource.type || '').toLowerCase()

  // NIC → Subnet, PublicIP
  if (type === 'microsoft.network/networkinterfaces') {
    for (const ipConfig of props.ipConfigurations || []) {
      const p = ipConfig.properties || {}
      if (p.subnet?.id)          refs.push({ targetId: p.subnet.id,          label: 'in subnet' })
      if (p.publicIPAddress?.id) refs.push({ targetId: p.publicIPAddress.id, label: 'has public IP' })
    }
    if (props.networkSecurityGroup?.id) refs.push({ targetId: props.networkSecurityGroup.id, label: 'uses NSG' })
  }

  // VM → NIC, Disk
  if (type === 'microsoft.compute/virtualmachines') {
    for (const nic of props.networkProfile?.networkInterfaces || []) {
      if (nic.id) refs.push({ targetId: nic.id, label: 'attached to' })
    }
    if (props.storageProfile?.osDisk?.managedDisk?.id)
      refs.push({ targetId: props.storageProfile.osDisk.managedDisk.id, label: 'os disk' })
    for (const d of props.storageProfile?.dataDisks || []) {
      if (d.managedDisk?.id) refs.push({ targetId: d.managedDisk.id, label: 'data disk' })
    }
  }

  // Subnet → NSG, RouteTable
  if (type === 'microsoft.network/virtualnetworks/subnets') {
    if (props.networkSecurityGroup?.id) refs.push({ targetId: props.networkSecurityGroup.id, label: 'protected by' })
    if (props.routeTable?.id)           refs.push({ targetId: props.routeTable.id,           label: 'routes via' })
  }

  // VNet → Subnets (child resources embedded in properties)
  if (type === 'microsoft.network/virtualnetworks') {
    for (const subnet of props.subnets || []) {
      if (subnet.id) refs.push({ targetId: subnet.id, label: 'contains' })
    }
  }

  // Function App / Web App → App Service Plan
  if (type === 'microsoft.web/sites') {
    if (props.serverFarmId) refs.push({ targetId: props.serverFarmId, label: 'runs on' })
  }

  // Logic App → nothing standard to extract without deep parsing
  return refs
}

/**
 * Builds the dependency graph for a resource group.
 * @param {string} subscriptionId
 * @param {string} resourceGroupId
 * @returns {{ nodes: Array, links: Array }}
 */
async function buildDependencyGraph(subscriptionId, resourceGroupId) {
  console.log('[buildDependencyGraph] starts — rg:', resourceGroupId)

  // 1. List all resources in the RG (returns minimal metadata)
  const rgConfig = await getResourceConfig(subscriptionId, resourceGroupId, null)
  const resources = rgConfig?.resources || []

  // 2. Fetch full properties for each resource in parallel (needed for relationship extraction)
  const fullResources = await Promise.all(
    resources.map(r =>
      getResourceConfig(subscriptionId, resourceGroupId, r.id)
        .catch(() => r)  // fallback to minimal if full fetch fails
    )
  )

  // 3. Build node map keyed by resource ID (normalised to lowercase for matching)
  const nodeMap = {}
  for (const r of fullResources) {
    if (!r?.id) continue
    nodeMap[r.id.toLowerCase()] = {
      id:       r.id,
      name:     r.name || r.id.split('/').pop(),
      type:     r.type || 'Unknown',
      location: r.location || '',
      color:    nodeColor(r.type),
      isDrifted: false,
      severity:  'none',
      val:       4,  // default node size
    }
  }

  // 4. Overlay drift status from driftIndex (last 7 days)
  try {
    const since  = new Date(Date.now() - 7 * 86400000).toISOString()
    const filter = `PartitionKey eq '${subscriptionId}' and Timestamp ge datetime'${since}'`
    for await (const entity of getDriftIndexTableClient().listEntities({ queryOptions: { filter } })) {
      const key = (entity.resourceId || '').toLowerCase()
      if (nodeMap[key]) {
        nodeMap[key].isDrifted = true
        nodeMap[key].severity  = entity.severity || 'low'
        nodeMap[key].val       = 8  // larger node if drifted
      }
    }
  } catch (driftError) {
    console.log('[buildDependencyGraph] drift overlay failed (non-fatal):', driftError.message)
  }

  // 5. Extract edges from resource properties
  const links = []
  const seenEdges = new Set()
  for (const r of fullResources) {
    if (!r?.id) continue
    for (const ref of parseReferences(r)) {
      const sourceKey = r.id.toLowerCase()
      const targetKey = ref.targetId.toLowerCase()
      // Only include edges where both nodes are in the graph
      if (!nodeMap[sourceKey] || !nodeMap[targetKey]) continue
      const edgeKey = `${sourceKey}→${targetKey}`
      if (seenEdges.has(edgeKey)) continue
      seenEdges.add(edgeKey)
      links.push({ source: r.id, target: ref.targetId, label: ref.label })
    }
  }

  const nodes = Object.values(nodeMap)
  console.log('[buildDependencyGraph] ends — nodes:', nodes.length, 'links:', links.length)
  return { nodes, links }
}

module.exports = { buildDependencyGraph }
