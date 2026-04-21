// ============================================================
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
// ============================================================
const { ResourceManagementClient } = require('@azure/arm-resources')
const { SubscriptionClient } = require('@azure/arm-subscriptions')
const { DefaultAzureCredential } = require('@azure/identity')

const credential = new DefaultAzureCredential()

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
    const version = stable[0] || apiVersions[0] || '2021-04-01'
    providerApiVersionCache[cacheKey] = version
    API_VERSION_MAP[key] = version
    console.log('[getApiVersion] ends — resolved from ARM:', version)
    return version
  } catch {
    console.log('[getApiVersion] ends — fallback to default 2021-04-01')
    return '2021-04-01'
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
  const client = resourceClient(subscriptionId)
  if (resourceId) {
    const parts      = resourceId.split('/')
    const provider   = parts[6]
    const type       = parts[7]
    const name       = parts[8]
    const apiVersion = await getApiVersion(subscriptionId, provider, type)

    const resource = await fetchWithFallback(client, resourceGroupName, provider, type, name, apiVersion)

    const children = CHILD_RESOURCES[type.toLowerCase()] || []
    if (children.length) {
      console.log('[getResourceConfig] fetching', children.length, 'child resource(s) for type:', type)
      const results = await Promise.allSettled(
        children.map(c =>
          client.resources.get(resourceGroupName, provider, `${type}/${name}`, c.child, c.name, c.apiVersion)
            .catch(() => null)
        )
      )
      resource._childConfig = {}
      children.forEach((c, i) => {
        if (results[i].value) resource._childConfig[c.child] = results[i].value
      })
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