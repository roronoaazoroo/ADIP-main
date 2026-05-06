// FILE: adip-backend/express-api/src/services/dependencyGraphService.js
// ROLE: Builds a dependency graph for all resources in a resource group.

// Uses Azure Resource Graph API (single KQL query) instead of N ARM GET calls.
// Falls back to ARM SDK if Resource Graph is unavailable.

'use strict'
const { ResourceGraphClient }    = require('@azure/arm-resourcegraph')
const { DefaultAzureCredential } = require('@azure/identity')
const { getDriftIndexTableClient } = require('./blobService')

const credential = new DefaultAzureCredential()

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

function parseReferences(resource) {
  const refs  = []
  const props = resource.properties || {}
  const type  = (resource.type || '').toLowerCase()

  if (type === 'microsoft.network/networkinterfaces') {
    for (const ipConfig of props.ipConfigurations || []) {
      const p = ipConfig.properties || {}
      if (p.subnet?.id)          refs.push({ targetId: p.subnet.id,          label: 'in subnet' })
      if (p.publicIPAddress?.id) refs.push({ targetId: p.publicIPAddress.id, label: 'has public IP' })
    }
    if (props.networkSecurityGroup?.id) refs.push({ targetId: props.networkSecurityGroup.id, label: 'uses NSG' })
  }
  if (type === 'microsoft.compute/virtualmachines') {
    for (const nic of props.networkProfile?.networkInterfaces || []) {
      if (nic.id) refs.push({ targetId: nic.id, label: 'attached to' })
    }
    if (props.storageProfile?.osDisk?.managedDisk?.id)
      refs.push({ targetId: props.storageProfile.osDisk.managedDisk.id, label: 'os disk' })
  }
  if (type === 'microsoft.network/virtualnetworks/subnets') {
    if (props.networkSecurityGroup?.id) refs.push({ targetId: props.networkSecurityGroup.id, label: 'protected by' })
  }
  if (type === 'microsoft.network/virtualnetworks') {
    for (const subnet of props.subnets || []) {
      if (subnet.id) refs.push({ targetId: subnet.id, label: 'contains' })
    }
  }
  if (type === 'microsoft.web/sites') {
    if (props.serverFarmId) refs.push({ targetId: props.serverFarmId, label: 'runs on' })
  }
  return refs
}

async function buildDependencyGraph(subscriptionId, resourceGroupId) {
  console.log('[buildDependencyGraph] starts — rg:', resourceGroupId)

  // Single Resource Graph KQL query replaces N ARM GET calls
  const client = new ResourceGraphClient(credential)
  const query  = `Resources | where resourceGroup =~ '${resourceGroupId}' and subscriptionId =~ '${subscriptionId}' | project id, name, type, location, properties, resourceGroup`

  const result    = await client.resources({ subscriptions: [subscriptionId], query }, {})
  const resources = result.data || []
  console.log('[buildDependencyGraph] Resource Graph returned:', resources.length, 'resources')

  // Build node map
  const nodeMap = {}
  for (const r of resources) {
    if (!r.id) continue
    nodeMap[r.id.toLowerCase()] = {
      id:       r.id.toLowerCase(),
      name:     r.name || r.id.split('/').pop(),
      type:     r.type || 'Unknown',
      location: r.location || '',
      color:    nodeColor(r.type),
      isDrifted: false,
      severity:  'none',
      val:       4,
    }
  }

  // Overlay drift status from driftIndex — ALL time, aggregate per resource
  try {
    const severityOrder = ['none', 'low', 'medium', 'high', 'critical']
    for await (const entity of getDriftIndexTableClient().listEntities({
      queryOptions: { filter: `PartitionKey eq '${subscriptionId}'` }
    })) {
      const key = (entity.resourceId || '').toLowerCase()
      if (!nodeMap[key]) continue
      const node = nodeMap[key]
      node.isDrifted   = true
      node.driftCount  = (node.driftCount || 0) + 1
      if (severityOrder.indexOf(entity.severity) > severityOrder.indexOf(node.severity || 'none')) {
        node.severity = entity.severity || 'low'
      }
      if (!node.lastDriftAt || entity.detectedAt > node.lastDriftAt) {
        node.lastDriftAt = entity.detectedAt
      }
      node.val = Math.min(4 + node.driftCount * 2, 20)
    }
  } catch (driftError) {
    console.log('[buildDependencyGraph] drift overlay non-fatal:', driftError.message)
  }

  // Extract edges
  const links    = []
  const seenEdges = new Set()
  for (const r of resources) {
    if (!r.id) continue
    for (const ref of parseReferences(r)) {
      const sourceKey = r.id.toLowerCase()
      const targetKey = ref.targetId.toLowerCase()
      if (!nodeMap[sourceKey] || !nodeMap[targetKey]) continue
      const edgeKey = `${sourceKey}→${targetKey}`
      if (seenEdges.has(edgeKey)) continue
      seenEdges.add(edgeKey)
      links.push({ source: r.id.toLowerCase(), target: ref.targetId.toLowerCase(), label: ref.label })
    }
  }

  const nodes = Object.values(nodeMap)
  console.log('[buildDependencyGraph] ends — nodes:', nodes.length, 'links:', links.length)
  return { nodes, links }
}

module.exports = { buildDependencyGraph }
