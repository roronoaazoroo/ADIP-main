const { ResourceManagementClient } = require('@azure/arm-resources')
const { SubscriptionClient } = require('@azure/arm-subscriptions')
const { DefaultAzureCredential } = require('@azure/identity')

const credential = new DefaultAzureCredential()

// Static API version map — covers the most common resource types
// Falls back to provider-level API version discovery if type not listed
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
  'databaseaccounts':         '2024-11-15',   // Cosmos DB
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

// Cache for provider API versions fetched from ARM
const providerApiVersionCache = {}

async function getApiVersion(subscriptionId, provider, type) {
  const key = type.toLowerCase()
  if (API_VERSION_MAP[key]) return API_VERSION_MAP[key]

  const cacheKey = `${provider}/${type}`
  if (providerApiVersionCache[cacheKey]) return providerApiVersionCache[cacheKey]

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
    // Also cache by type key for future lookups
    API_VERSION_MAP[key] = version
    return version
  } catch {
    return '2021-04-01'
  }
}

function resourceClient(subscriptionId) {
  return new ResourceManagementClient(credential, subscriptionId)
}

async function listSubscriptions() {
  const client = new SubscriptionClient(credential)
  const subs = []
  for await (const s of client.subscriptions.list()) subs.push(s)
  return subs
}

async function listResourceGroups(subscriptionId) {
  const client = resourceClient(subscriptionId)
  const rgs = []
  for await (const rg of client.resourceGroups.list()) rgs.push(rg)
  return rgs
}

async function listResources(subscriptionId, resourceGroupName) {
  const client = resourceClient(subscriptionId)
  const resources = []
  for await (const r of client.resources.listByResourceGroup(resourceGroupName)) resources.push(r)
  return resources
}

async function getResourceConfig(subscriptionId, resourceGroupName, resourceId) {
  const client = resourceClient(subscriptionId)
  if (resourceId) {
    const parts      = resourceId.split('/')
    const provider   = parts[6]
    const type       = parts[7]
    const name       = parts[8]
    const apiVersion = await getApiVersion(subscriptionId, provider, type)
    try {
      return await client.resources.get(resourceGroupName, provider, '', type, name, apiVersion)
    } catch (err) {
      // Extract correct version from error message and retry once
      const match = err.message?.match(/The supported api-versions are '([^']+)'/)
      if (match) {
        const versions = match[1].split(', ')
        const stable   = versions.filter(v => !v.includes('preview'))
        const fallback = stable[stable.length - 1] || versions[versions.length - 1]
        // Cache it so subsequent calls use the right version
        API_VERSION_MAP[type.toLowerCase()] = fallback
        return await client.resources.get(resourceGroupName, provider, '', type, name, fallback)
      }
      throw err
    }
  }
  const resources = []
  for await (const r of client.resources.listByResourceGroup(resourceGroupName, { expand: 'properties' })) {
    resources.push(r)
  }
  const rg = await client.resourceGroups.get(resourceGroupName)
  return { resourceGroup: rg, resources }
}

module.exports = { listSubscriptions, listResourceGroups, listResources, getResourceConfig, getApiVersion }
