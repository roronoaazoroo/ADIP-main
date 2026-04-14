require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') })
const { ResourceManagementClient } = require('@azure/arm-resources')
const { DefaultAzureCredential }   = require('@azure/identity')
const { BlobServiceClient }        = require('@azure/storage-blob')

const { blobKey, writeBlob }       = require('adip-shared/blobHelpers')
const { API_VERSION_MAP }          = require('adip-shared/constants')

const blobService  = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
const baselineCtr  = blobService.getContainerClient('baselines')

// ── getResourceConfig START ───────────────────────────────────────────────────
// Fetches live ARM config for a specific resource or full resource group
async function getResourceConfig(subscriptionId, resourceGroupId, resourceId) {
  const credential = new DefaultAzureCredential()
  const armClient  = new ResourceManagementClient(credential, subscriptionId)

  if (resourceId && resourceId.startsWith('/subscriptions/')) {
    const parts      = resourceId.split('/')
    const provider   = parts[6], type = parts[7], name = parts[8]
    const apiVersion = API_VERSION_MAP[type?.toLowerCase()] || '2021-04-01'
    return armClient.resources.get(parts[4], provider, '', type, name, apiVersion)
  }

  const resources = []
  for await (const r of armClient.resources.listByResourceGroup(resourceGroupId, { expand: 'properties' })) {
    resources.push(r)
  }
  const rg = await armClient.resourceGroups.get(resourceGroupId)
  return { resourceGroup: rg, resources }
}
// ── getResourceConfig END ─────────────────────────────────────────────────────


// ── Main handler START ────────────────────────────────────────────────────────
module.exports = async function (context, req) {
  const { subscriptionId, resourceGroupId, resourceId } = req.body || {}

  if (!subscriptionId || !resourceGroupId || !resourceId) {
    context.res = { status: 400, body: { error: 'subscriptionId, resourceGroupId and resourceId required' } }
    return
  }

  try {
    const liveConfig = await getResourceConfig(subscriptionId, resourceGroupId, resourceId)
    const key        = blobKey(resourceId)
    const doc        = {
      id: key,
      subscriptionId,
      resourceGroupId,
      resourceId,
      resourceState: liveConfig,
      active:        true,
      promotedAt:    new Date().toISOString(),
    }

    await writeBlob(baselineCtr, key, doc)

    context.res = { status: 200, body: { message: 'Golden baseline seeded from live config', baseline: doc } }
    context.log(`[seedBaseline] seeded baseline for ${resourceId}`)
  } catch (err) {
    context.log.error('[seedBaseline] error:', err.message)
    context.res = { status: 500, body: { error: err.message } }
  }
}
// ── Main handler END ──────────────────────────────────────────────────────────
