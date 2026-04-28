'use strict'
// FILE: services/azureResourceService.js
// ROLE: All Azure Resource Manager (ARM) API calls — subscriptions, RGs, resources, API versions
//
// Key functions:
//   listSubscriptions()                          — all accessible subscriptions
//   listResourceGroups(subscriptionId)           — all RGs in a subscription
//   listResources(subscriptionId, rgName)        — all resources in an RG
//   getResourceConfig(subscriptionId, rg, id)    — full live ARM config for a resource or RG
//   getApiVersion(subscriptionId, provider, type) — resolves ARM API version
//     checks API_VERSION_MAP first, then queries ARM dynamically, caches result
//   fetchWithFallback(client, rg, provider, type, name, apiVersion)
//     — ARM GET with automatic API version correction on 400 errors

const { ResourceManagementClient } = require('@azure/arm-resources')
const { SubscriptionClient }       = require('@azure/arm-subscriptions')
const { DefaultAzureCredential }   = require('@azure/identity')
const fetch                        = require('node-fetch')

const credential = new DefaultAzureCredential()

// Fallback ARM API version used when a resource type is not in the static map
// and ARM dynamic lookup fails
const ARM_API_VERSION_FALLBACK = '2021-04-01'

// ARM management endpoint — configurable for sovereign cloud support
const ARM_ENDPOINT = process.env.ARM_ENDPOINT || 'https://management.azure.com'

// Static API version map — covers the most common resource types
const API_VERSION_MAP = {
  'storageaccounts':          '2023-01-01',
  'virtualmachines':          '2023-07-01',
  'workflows':                '2019-05-01',
  'sites':                    '2023-01-01',
  'vaults':                   '2023-07-01',
  'virtualnetworks':          '2023-05-01',
  'networksecuritygroups':    '2023-05-01',
  'publicipaddresses':        '2023-05-01',
  'networkinterfaces':        '2023-05-01',
  'disks':                    '2023-04-02',
  'servers':                  '2023-05-01',
  'databases':                '2023-05-01',
  'components':               '2020-02-02',
  'databaseaccounts':         '2024-11-15',
  'namespaces':               '2022-10-01',
  'topics':                   '2022-06-15',
  'registries':               '2023-07-01',
  'managedclusters':          '2023-08-01',
  'loadbalancers':            '2023-05-01',
  'applicationgateways':      '2023-05-01',
  'accounts':                 '2023-11-01',
  'flexibleservers':          '2023-06-01-preview',
  'redis':                    '2023-08-01',
  'searchservices':           '2023-11-01',
  'serverfarms':              '2023-01-01',
  'connections':              '2023-05-01',
  'dnszones':                 '2018-05-01',
  'privatednszones':          '2020-06-01',
  'bastionhosts':             '2023-05-01',
  'virtualnetworkgateways':   '2023-05-01',
  'routetables':              '2023-05-01',
  'availabilitysets':         '2023-07-01',
  'snapshots':                '2023-04-02',
  'images':                   '2023-07-01',
  'containergroups':          '2023-05-01',
}

// Cache for provider API versions fetched dynamically from ARM
const providerApiVersionCache = {}


// ── getApiVersion START ──────────────────────────────────────────────────────
// Resolves the ARM API version for a resource type — checks static map first, then queries ARM
async function getApiVersion(subscriptionId, provider, type) {
  console.log('[getApiVersion] starts — provider:', provider, 'type:', type)
  if (!provider || !type) {
    console.log('[getApiVersion] ends — missing provider or type, using fallback')
    return ARM_API_VERSION_FALLBACK
  }
  const key = type.toLowerCase()
  if (API_VERSION_MAP[key]) {
    console.log('[getApiVersion] ends — found in static map:', API_VERSION_MAP[key])
    return API_VERSION_MAP[key]
  }

  const cacheKey = `${provider}/${type}`
  if (providerApiVersionCache[cacheKey]) {
    console.log('[getApiVersion] ends — found in cache:', providerApiVersionCache[cacheKey])
    return providerApiVersionCache[cacheKey]
  }

  try {
    const client = resourceClient(subscriptionId)
    const providerInfo = await client.providers.get(provider)
    const resourceType = providerInfo.resourceTypes?.find(
      rt => rt.resourceType?.toLowerCase() === type.toLowerCase()
    )
    const apiVersions = resourceType?.apiVersions || []
    const stable = apiVersions.filter(v => !v.includes('preview'))
    const version = stable[0] || apiVersions[0] || ARM_API_VERSION_FALLBACK
    providerApiVersionCache[cacheKey] = version
    API_VERSION_MAP[key] = version
    console.log('[getApiVersion] ends — resolved from ARM:', version)
    return version
  } catch {
    console.log('[getApiVersion] ends — fallback to default', ARM_API_VERSION_FALLBACK)
    return ARM_API_VERSION_FALLBACK
  }
}
// ── getApiVersion END ────────────────────────────────────────────────────────


// ── resourceClient START ─────────────────────────────────────────────────────
// Returns a new ResourceManagementClient for the given subscription
function resourceClient(subscriptionId) {
  console.log('[resourceClient] starts — subscriptionId:', subscriptionId)
  const client = new ResourceManagementClient(credential, subscriptionId)
  console.log('[resourceClient] ends')
  return client
}
// ── resourceClient END ───────────────────────────────────────────────────────


// ── listSubscriptions START ──────────────────────────────────────────────────
// Lists all Azure subscriptions accessible to the current credential
async function listSubscriptions() {
  console.log('[listSubscriptions] starts')
  const client = new SubscriptionClient(credential)
  const subs = []
  for await (const s of client.subscriptions.list()) subs.push(s)
  console.log('[listSubscriptions] ends — found:', subs.length, 'subscriptions')
  return subs
}
// ── listSubscriptions END ────────────────────────────────────────────────────


// ── listResourceGroups START ─────────────────────────────────────────────────
// Lists all resource groups in the given subscription
async function listResourceGroups(subscriptionId) {
  console.log('[listResourceGroups] starts — subscriptionId:', subscriptionId)
  const client = resourceClient(subscriptionId)
  const rgs = []
  for await (const rg of client.resourceGroups.list()) rgs.push(rg)
  console.log('[listResourceGroups] ends — found:', rgs.length, 'resource groups')
  return rgs
}
// ── listResourceGroups END ───────────────────────────────────────────────────


// ── listResources START ──────────────────────────────────────────────────────
// Lists all resources in the given resource group
async function listResources(subscriptionId, resourceGroupName) {
  console.log('[listResources] starts — subscriptionId:', subscriptionId, 'rg:', resourceGroupName)
  const client = resourceClient(subscriptionId)
  const resources = []
  for await (const r of client.resources.listByResourceGroup(resourceGroupName)) resources.push(r)
  console.log('[listResources] ends — found:', resources.length, 'resources')
  return resources
}
// ── listResources END ────────────────────────────────────────────────────────


// Child resource paths to fetch and merge for each parent resource type
// Each entry: { child: ARM child resource type, name: resource name, apiVersion }
const CHILD_RESOURCES = {
  storageaccounts: [
    { child: 'blobServices',  name: 'default', apiVersion: '2023-01-01' },
    { child: 'fileServices',  name: 'default', apiVersion: '2023-01-01' },
    { child: 'queueServices', name: 'default', apiVersion: '2023-01-01' },
    { child: 'tableServices', name: 'default', apiVersion: '2023-01-01' },
  ],
  sites: [
    { child: 'config', name: 'web', apiVersion: '2023-01-01' },
  ],
}

// Storage container/share/queue/table list API versions
const STORAGE_LIST_API_VERSION = '2023-01-01'

// ── fetchStorageChildItems START ─────────────────────────────────────────────
// Lists the actual containers, file shares, queues, and tables inside a storage account
// These are user-created resources that live under the service paths:
//   blobServices/default/containers, fileServices/default/shares,
//   queueServices/default/queues, tableServices/default/tables
// The ARM SDK's ResourceManagementClient doesn't expose these nested list endpoints,
// so we call the ARM REST API directly using the module-level DefaultAzureCredential
async function fetchStorageChildItems(subscriptionId, resourceGroupName, storageAccountName) {
  console.log('[fetchStorageChildItems] starts — account:', storageAccountName)

  const storageChildItems = {}

  // Get a bearer token using the same credential used for all other ARM calls
  const armBearerToken = await credential.getToken('https://management.azure.com/.default')

  // Helper: calls a storage account child list endpoint and returns the items array
  async function listStorageChildResources(childResourcePath) {
    const armListUrl = `${ARM_ENDPOINT}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Storage/storageAccounts/${storageAccountName}/${childResourcePath}?api-version=${STORAGE_LIST_API_VERSION}`
    try {
      const httpResponse = await fetch(armListUrl, {
        headers: { 'Authorization': `Bearer ${armBearerToken.token}`, 'Content-Type': 'application/json' }
      })
      if (!httpResponse.ok) return []
      const responseData = await httpResponse.json()
      return (responseData.value || []).map(item => ({
        name:       item.name,
        id:         item.id,
        properties: item.properties,
      }))
    } catch {
      return []  // non-fatal — some storage accounts may not have all service types enabled
    }
  }

  const [blobContainers, fileShares, storageQueues, storageTables] = await Promise.all([
    listStorageChildResources('blobServices/default/containers'),
    listStorageChildResources('fileServices/default/shares'),
    listStorageChildResources('queueServices/default/queues'),
    listStorageChildResources('tableServices/default/tables'),
  ])

  if (blobContainers.length)  storageChildItems.blobContainers  = blobContainers
  if (fileShares.length)      storageChildItems.fileShares      = fileShares
  if (storageQueues.length)   storageChildItems.storageQueues   = storageQueues
  if (storageTables.length)   storageChildItems.storageTables   = storageTables

  console.log('[fetchStorageChildItems] ends — containers:', blobContainers.length,
    'shares:', fileShares.length, 'queues:', storageQueues.length, 'tables:', storageTables.length)
  return storageChildItems
}
// ── fetchStorageChildItems END ───────────────────────────────────────────────


// ── fetchWithFallback START ──────────────────────────────────────────────────
// Attempts an ARM GET and automatically retries with a corrected API version on 400 mismatch errors
async function fetchWithFallback(client, rg, provider, type, name, apiVersion) {
  console.log('[fetchWithFallback] starts — type:', type, 'name:', name, 'apiVersion:', apiVersion)
  try {
    const result = await client.resources.get(rg, provider, '', type, name, apiVersion)
    console.log('[fetchWithFallback] ends')
    return result
  } catch (err) {
    const match = err.message?.match(/The supported api-versions are '([^']+)'/)
    if (match) {
      const versions = match[1].split(', ')
      const stable   = versions.filter(v => !v.includes('preview'))
      const fallback = stable[stable.length - 1] || versions[versions.length - 1]
      API_VERSION_MAP[type.toLowerCase()] = fallback
      const result = await client.resources.get(rg, provider, '', type, name, fallback)
      console.log('[fetchWithFallback] ends — used fallback version:', fallback)
      return result
    }
    console.log('[fetchWithFallback] ends — rethrown error')
    throw err
  }
}
// ── fetchWithFallback END ────────────────────────────────────────────────────

// ── getResourceConfig START ──────────────────────────────────────────────────
// Fetches the live ARM configuration for a specific resource or all resources in a resource group
// Also fetches child resources (e.g. blobServices) and merges them into _childConfig
async function getResourceConfig(subscriptionId, resourceGroupName, resourceId) {
  console.log('[getResourceConfig] starts — subscriptionId:', subscriptionId, 'rg:', resourceGroupName, 'resourceId:', resourceId)
  if (!subscriptionId || !resourceGroupName) {
    throw new Error('getResourceConfig requires subscriptionId and resourceGroupName')
  }
  const client = resourceClient(subscriptionId)
  if (resourceId) {
    const parts      = resourceId.split('/')
    const provider   = parts[6]
    const type       = parts[7]
    const name       = parts[8]
    const apiVersion = await getApiVersion(subscriptionId, provider, type)

    const resource = await fetchWithFallback(client, resourceGroupName, provider, type, name, apiVersion)

    const childResourceDefinitions = CHILD_RESOURCES[type.toLowerCase()] || []
    if (childResourceDefinitions.length) {
      console.log('[getResourceConfig] fetching', childResourceDefinitions.length, 'child resource(s) for type:', type)
      const childFetchResults = await Promise.allSettled(
        childResourceDefinitions.map(childDefinition =>
          client.resources.get(resourceGroupName, provider, `${type}/${name}`, childDefinition.child, childDefinition.name, childDefinition.apiVersion)
            .catch(() => null)
        )
      )
      resource._childConfig = {}
      childResourceDefinitions.forEach((childDefinition, index) => {
        if (childFetchResults[index].value) resource._childConfig[childDefinition.child] = childFetchResults[index].value
      })
    }

    // For storage accounts: also list the actual containers, file shares, queues, and tables
    // These are user-created resources that the service settings (blobServices/default) don't include
    if (type.toLowerCase() === 'storageaccounts') {
      const storageChildItems = await fetchStorageChildItems(subscriptionId, resourceGroupName, name)
      if (Object.keys(storageChildItems).length > 0) {
        resource._childConfig = resource._childConfig || {}
        Object.assign(resource._childConfig, storageChildItems)
      }
    }

    console.log('[getResourceConfig] ends — single resource')
    return resource
  }
  const resources = []
  for await (const r of client.resources.listByResourceGroup(resourceGroupName, { expand: 'properties' })) {
    resources.push(r)
  }
  const rg = await client.resourceGroups.get(resourceGroupName)
  console.log('[getResourceConfig] ends — resource group with', resources.length, 'resources')
  return { resourceGroup: rg, resources }
}
// ── getResourceConfig END ────────────────────────────────────────────────────

module.exports = { listSubscriptions, listResourceGroups, listResources, getResourceConfig, getApiVersion }