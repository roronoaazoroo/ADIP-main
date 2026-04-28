// FILE: adip-backend/function-app/seedBaseline/index.js
// ROLE: Azure Function — seeds the golden baseline from the current live ARM config

// Trigger: HTTP POST (called by Express POST /api/seed-baseline)

// What this function does:
//   1. Receives { subscriptionId, resourceGroupId, resourceId } from the request body
//   2. Fetches the current live ARM config (or full RG config if no specific resource)
//   3. Saves it as the golden baseline blob in 'baselines' container
//   4. After this, ComparisonPage will diff future live configs against this snapshot

'use strict'
'use strict'
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') })
const { ResourceManagementClient } = require('@azure/arm-resources')
const { DefaultAzureCredential }   = require('@azure/identity')
const { BlobServiceClient }        = require('@azure/storage-blob')

const { blobKey, writeBlob }       = require('adip-shared/blobHelpers')
const { API_VERSION_MAP }          = require('adip-shared/constants')

// Connect to the 'baselines' blob container where golden baseline JSON documents are stored
const blobStorageClient  = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
const baselinesContainer = blobStorageClient.getContainerClient('baselines')

// ── fetchLiveArmConfig START ──────────────────────────────────────────────────
// Fetches the current live ARM config for a specific resource or a full resource group
// If resourceId is a full ARM ID (/subscriptions/...), fetches that specific resource
// Otherwise fetches all resources in the resource group
async function fetchLiveArmConfig(subscriptionId, resourceGroupId, resourceId) {
  console.log('[fetchLiveArmConfig] starts — subscriptionId:', subscriptionId, 'resourceGroupId:', resourceGroupId, 'resourceId:', resourceId)
  const azureCredential = new DefaultAzureCredential()
  const armClient       = new ResourceManagementClient(azureCredential, subscriptionId)

  if (resourceId && resourceId.startsWith('/subscriptions/')) {
    // Parse the ARM resource ID: /subscriptions/{sub}/resourceGroups/{rg}/providers/{provider}/{type}/{name}
    console.log('[fetchLiveArmConfig] fetching single resource — parsing ARM ID')
    const resourceIdParts   = resourceId.split('/')
    const providerNamespace = resourceIdParts[6]
    const resourceTypeName  = resourceIdParts[7]
    const resourceName      = resourceIdParts[8]
    const armApiVersion     = API_VERSION_MAP[resourceTypeName?.toLowerCase()] || '2021-04-01'
    console.log('[fetchLiveArmConfig] ARM ID parsed — provider:', providerNamespace, 'type:', resourceTypeName, 'name:', resourceName, 'apiVersion:', armApiVersion)
    const result = await armClient.resources.get(resourceIdParts[4], providerNamespace, '', resourceTypeName, resourceName, armApiVersion)
    console.log('[fetchLiveArmConfig] ends — single resource fetched')
    return result
  }

  // Resource group level — list all resources in the RG
  console.log('[fetchLiveArmConfig] fetching RG-level config for:', resourceGroupId)
  const resources = []
  for await (const r of armClient.resources.listByResourceGroup(resourceGroupId, { expand: 'properties' })) {
    resources.push(r)
  }
  const rg = await armClient.resourceGroups.get(resourceGroupId)
  console.log('[fetchLiveArmConfig] ends — RG-level config fetched, resources found:', resources.length)
  return { resourceGroup: rg, resources }
}
// ── fetchLiveArmConfig END ────────────────────────────────────────────────────


// ── Main handler START ────────────────────────────────────────────────────────
module.exports = async function (context, req) {
  console.log('[seedBaseline mainHandler] starts')
  const { subscriptionId, resourceGroupId, resourceId } = req.body || {}

  if (!subscriptionId || !resourceGroupId || !resourceId) {
    console.log('[seedBaseline mainHandler] ends — 400 missing required fields — subscriptionId:', !!subscriptionId, 'resourceGroupId:', !!resourceGroupId, 'resourceId:', !!resourceId)
    context.res = { status: 400, body: { error: 'subscriptionId, resourceGroupId and resourceId required' } }
    return
  }

  console.log('[seedBaseline mainHandler] processing — resourceId:', resourceId)

  try {
    // ── Live config fetch START ─────────────────────────────────────────────
    console.log('[seedBaseline liveConfigFetch] starts')
    const currentLiveConfig = await fetchLiveArmConfig(subscriptionId, resourceGroupId, resourceId)
    console.log('[seedBaseline liveConfigFetch] ends — live config retrieved')
    // ── Live config fetch END ───────────────────────────────────────────────

    // ── Baseline blob write START ───────────────────────────────────────────
    // Build the baseline document and save it to blob storage
    const baselineBlobKey  = blobKey(resourceId)
    console.log('[seedBaseline baselineBlobWrite] starts — blobKey:', baselineBlobKey)
    const baselineDocument = {
      id:             baselineBlobKey,
      subscriptionId,
      resourceGroupId,
      resourceId,
      resourceState:  currentLiveConfig,  // the full ARM config at this point in time
      active:         true,
      promotedAt:     new Date().toISOString(),
    }
    await writeBlob(baselinesContainer, baselineBlobKey, baselineDocument)
    console.log('[seedBaseline baselineBlobWrite] ends — baseline blob saved to baselines container')
    // ── Baseline blob write END ─────────────────────────────────────────────

    context.res = { status: 200, body: { message: 'Golden baseline seeded from live config', baseline: baselineDocument } }
    context.log(`[seedBaseline] seeded baseline for ${resourceId}`)
    console.log('[seedBaseline mainHandler] ends — baseline seeded successfully for resourceId:', resourceId)
  } catch (seedError) {
    console.log('[seedBaseline mainHandler] ends — caught error:', seedError.message)
    context.log.error('[seedBaseline] error:', seedError.message)
    context.res = { status: 500, body: { error: seedError.message } }
  }
}
// ── Main handler END ──────────────────────────────────────────────────────────