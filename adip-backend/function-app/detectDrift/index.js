require('dotenv').config()
const { ResourceManagementClient } = require('@azure/arm-resources')
const { DefaultAzureCredential } = require('@azure/identity')
const { CosmosClient } = require('@azure/cosmos')
const { diff } = require('deep-diff')
const fetch = require('node-fetch')

const cosmos = new CosmosClient({ endpoint: process.env.COSMOS_ENDPOINT, key: process.env.COSMOS_KEY })
const db = cosmos.database(process.env.COSMOS_DB || 'adip-db')
const driftContainer    = db.container(process.env.COSMOS_CONTAINER_DRIFT    || 'drift-records')
const baselineContainer = db.container(process.env.COSMOS_CONTAINER_BASELINE || 'baselines')

const VOLATILE = ['etag', 'changedTime', 'createdTime', 'provisioningState', 'lastModifiedAt', 'systemData', '_ts', '_etag']
const CRITICAL_PATHS = ['properties.networkAcls', 'properties.accessPolicies', 'properties.securityRules', 'sku', 'location', 'identity', 'properties.encryption']

function strip(obj) {
  if (Array.isArray(obj)) return obj.map(strip)
  if (obj && typeof obj === 'object')
    return Object.fromEntries(Object.entries(obj).filter(([k]) => !VOLATILE.includes(k)).map(([k, v]) => [k, strip(v)]))
  return obj
}

function classifySeverity(diffs) {
  if (!diffs.length) return 'none'
  if (diffs.some(d => d.kind === 'D')) return 'critical'
  if (diffs.some(d => CRITICAL_PATHS.some(p => d.path?.join('.').startsWith(p)))) return 'high'
  if (diffs.length > 5) return 'medium'
  return 'low'
}

module.exports = async function (context, req) {
  // Event Grid webhook validation handshake
  const body = req.body
  if (Array.isArray(body) && body[0]?.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent') {
    context.res = { status: 200, body: { validationResponse: body[0].data.validationCode } }
    return
  }

  // Event Grid delivers events as array — extract first event's data
  const eventData = Array.isArray(body) ? body[0]?.data : body
  const { resourceId, subscriptionId } = eventData || {}
  if (!resourceId || !subscriptionId) {
    context.res = { status: 400, body: { error: 'resourceId and subscriptionId required' } }
    return
  }

  try {
    const credential = new DefaultAzureCredential()
    const armClient = new ResourceManagementClient(credential, subscriptionId)

    // Parse resource ID parts
    const parts = resourceId.split('/')
    const resourceGroupName = parts[4]
    const provider = parts[6]
    const type     = parts[7]
    const name     = parts[8]

    // Dynamic API version map — avoids 500 errors for non-storage resource types
    const API_VERSION_MAP = {
      'storageaccounts': '2023-01-01', 'virtualmachines': '2023-07-01',
      'workflows': '2019-05-01', 'sites': '2023-01-01', 'vaults': '2023-07-01',
      'virtualnetworks': '2023-05-01', 'networksecuritygroups': '2023-05-01',
      'accounts': '2023-11-01', 'components': '2020-02-02',
    }
    const apiVersion = API_VERSION_MAP[type.toLowerCase()] || '2021-04-01'

    // Fetch live config
    const liveRaw = await armClient.resources.get(resourceGroupName, provider, '', type, name, apiVersion)
    const live = strip(liveRaw)

    // Fetch baseline from Cosmos DB
    const { resources: baselines } = await baselineContainer.items.query({
      query: 'SELECT TOP 1 * FROM c WHERE c.resourceId = @rid AND c.active = true ORDER BY c._ts DESC',
      parameters: [{ name: '@rid', value: resourceId }],
    }).fetchAll()
    const baseline = baselines[0]

    const differences = baseline ? (diff(strip(baseline.resourceState), live) || []) : []
    const severity = classifySeverity(differences)

    const record = {
      id: `drift-${Date.now()}-${Math.random()}`,
      subscriptionId,
      resourceId,
      resourceGroup: resourceGroupName,
      liveState: live,
      baselineState: baseline?.resourceState || null,
      differences,
      severity,
      changeCount: differences.length,
      detectedAt: new Date().toISOString(),
    }

    if (differences.length > 0) {
      await driftContainer.items.create(record)

      // Notify Express API to push via Socket.IO
      const apiUrl = process.env.EXPRESS_API_URL
      if (apiUrl) {
        await fetch(`${apiUrl}/internal/drift-event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(record),
        }).catch(() => {})
      }
    }

    context.res = { status: 200, body: record }
  } catch (err) {
    context.log.error('detectDrift error:', err.message)
    context.res = { status: 500, body: { error: err.message } }
  }
}
