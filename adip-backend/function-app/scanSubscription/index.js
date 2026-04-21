// FILE: adip-backend/function-app/scanSubscription/index.js
// ROLE: Azure Function — hourly full subscription sweep for drift

// Trigger: Timer — every 1 hour

// What this function does:
//   1. Lists all accessible Azure subscriptions
//   2. For each subscription, lists all resource groups
//   3. For each resource group (5 at a time in parallel), lists all resources
//   4. For each resource that has a baseline blob, fetches live ARM config,
//      diffs against baseline, and saves a drift record if changes are found
//   5. Notifies Express /internal/drift-event to push to Socket.IO

// Counters: subCount, resourceCount, driftCount — logged at the end

require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') })
const { ResourceManagementClient } = require('@azure/arm-resources')
const { SubscriptionClient }       = require('@azure/arm-subscriptions')
const { DefaultAzureCredential }   = require('@azure/identity')
const { BlobServiceClient }        = require('@azure/storage-blob')
const { TableClient }              = require('@azure/data-tables')
const fetch                        = require('node-fetch')

const { strip, diffObjects }       = require('adip-shared/diff')
const { classifySeverity }         = require('adip-shared/severity')
const { blobKey, driftKey, readBlob, writeBlob } = require('adip-shared/blobHelpers')
const { API_VERSION_MAP }          = require('adip-shared/constants')

const blobStorageClient      = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
const baselinesContainer     = blobStorageClient.getContainerClient('baselines')     // golden baseline blobs
const driftRecordsContainer  = blobStorageClient.getContainerClient('drift-records') // detected drift blobs

// Returns a Table Storage client for the driftIndex table (fast queries for /api/drift-events)
function getDriftIndexTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'driftIndex')
}

// ── scanResource START ────────────────────────────────────────────────────────
// Fetches live config for one resource, diffs against baseline, writes drift record
// scanResource — checks one resource for drift against its stored baseline
// Called for every resource in every resource group across all subscriptions
async function scanResource(context, armClient, subscriptionId, resourceGroupName, resourceToScan) {
  // Parse the ARM resource ID to extract provider, type, and name
  const resourceIdParts   = resourceToScan.id.split('/')
  const providerNamespace = resourceIdParts[6]
  const resourceTypeName  = resourceIdParts[7]
  const resourceName      = resourceIdParts[8]
  if (!providerNamespace || !resourceTypeName || !resourceName) return

  const armApiVersion = API_VERSION_MAP[resourceTypeName?.toLowerCase()] || '2021-04-01'

  try {
    // Fetch the current live ARM config for this resource
    const liveConfigRaw      = await armClient.resources.get(resourceGroupName, providerNamespace, '', resourceTypeName, resourceName, armApiVersion)
    const liveConfigStripped = strip(liveConfigRaw)

    // Read the stored golden baseline — skip if none exists
    const baselineDocument       = await readBlob(baselinesContainer, blobKey(resourceToScan.id))
    if (!baselineDocument?.resourceState) return

    const baselineConfigStripped = strip(baselineDocument.resourceState)
    const detectedChanges        = diffObjects(baselineConfigStripped, liveConfigStripped)
    const driftSeverity          = classifySeverity(detectedChanges)

    if (detectedChanges.length === 0) return  // resource matches baseline — no drift

    const detectedAt = new Date().toISOString()
    const driftRecord = {
      subscriptionId,
      resourceId:    resourceToScan.id,
      resourceGroup: resourceGroupName,
      liveState:     liveConfigStripped,
      baselineState: baselineConfigStripped,
      differences:   detectedChanges,
      changes:       detectedChanges,
      severity:      driftSeverity,
      changeCount:   detectedChanges.length,
      hasPrevious:   true,
      detectedAt,
      source:        'scanSubscription-hourly',  // identifies this came from the hourly timer
    }

    // Save the drift record blob to 'drift-records' container
    const driftBlobKey = driftKey(resourceToScan.id, detectedAt)
    await writeBlob(driftRecordsContainer, driftBlobKey, driftRecord)

    // Write a lightweight index row to driftIndex Table for fast queries
    const tableRowKey = Buffer.from(driftBlobKey).toString('base64url').slice(0, 512)
    await getDriftIndexTable().upsertEntity({
      partitionKey:  subscriptionId,
      rowKey:        tableRowKey,
      blobKey:       driftBlobKey,
      resourceId:    resourceToScan.id,
      resourceGroup: resourceGroupName,
      severity:      driftSeverity,
      detectedAt,
      changeCount:   detectedChanges.length,
    }, 'Replace').catch(() => {})

    // Notify the Express API so it can push the event to the browser via Socket.IO
    const expressApiUrl = process.env.EXPRESS_API_URL
    if (expressApiUrl) {
      fetch(`${expressApiUrl}/internal/drift-event`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(driftRecord),
      }).catch(() => {})
    }

    context.log(`[scanSubscription] drift: ${driftSeverity} — ${detectedChanges.length} change(s) on ${resourceName}`)
  } catch (scanError) {
    context.log.warn(`[scanSubscription] skip ${resourceToScan.id}: ${scanError.message}`)
  }
}
// ── scanResource END ──────────────────────────────────────────────────────────


// ── Main handler START ────────────────────────────────────────────────────────
// Runs every hour — scans all resources with baselines across all accessible subscriptions
module.exports = async function (context, timer) {
  if (timer.isPastDue) context.log('[scanSubscription] timer past due — running anyway')

  const azureCredential    = new DefaultAzureCredential()
  const subscriptionClient = new SubscriptionClient(azureCredential)

  // Counters for the summary log at the end
  let subscriptionsScanned = 0, resourcesChecked = 0, driftsRecorded = 0

  try {
    for await (const subscription of subscriptionClient.subscriptions.list()) {
      const subscriptionId = subscription.subscriptionId
      if (!subscriptionId) continue
      subscriptionsScanned++

      const armClient = new ResourceManagementClient(azureCredential, subscriptionId)

      // Collect all resource groups in this subscription
      const allResourceGroups = []
      for await (const resourceGroup of armClient.resourceGroups.list()) allResourceGroups.push(resourceGroup)

      // Scan resource groups in parallel batches of 5 to avoid ARM throttling
      for (let batchStart = 0; batchStart < allResourceGroups.length; batchStart += 5) {
        const resourceGroupBatch = allResourceGroups.slice(batchStart, batchStart + 5)
        await Promise.allSettled(resourceGroupBatch.map(async resourceGroup => {
          const resourcesInGroup = []
          for await (const resource of armClient.resources.listByResourceGroup(resourceGroup.name)) resourcesInGroup.push(resource)
          await Promise.allSettled(resourcesInGroup.map(resource => {
            resourcesChecked++
            return scanResource(context, armClient, subscriptionId, resourceGroup.name, resource)
              .then(() => driftsRecorded++)
              .catch(() => {})
          }))
        }))
      }
    }
  } catch (err) {
    context.log.error('[scanSubscription] fatal:', err.message)
  }

  context.log(`[scanSubscription] done — ${subscriptionsScanned} subs, ${resourcesChecked} resources checked, ${driftsRecorded} drifts recorded`)
}
// ── Main handler END ──────────────────────────────────────────────────────────
