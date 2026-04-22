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

const blobStorageClient     = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
const baselinesContainer    = blobStorageClient.getContainerClient('baselines')     // golden baseline blobs
const driftRecordsContainer = blobStorageClient.getContainerClient('drift-records') // detected drift blobs

// Returns a Table Storage client for the driftIndex table (fast queries for /api/drift-events)
function getDriftIndexTable() {
  console.log('[getDriftIndexTable] starts')
  const client = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'driftIndex')
  console.log('[getDriftIndexTable] ends')
  return client
}

// ── scanResource START ────────────────────────────────────────────────────────
// Fetches live config for one resource, diffs against baseline, writes drift record
// scanResource — checks one resource for drift against its stored baseline
// Called for every resource in every resource group across all subscriptions
async function scanResource(context, armClient, subscriptionId, resourceGroupName, resourceToScan) {
  console.log('[scanResource] starts — resourceId:', resourceToScan.id)

  // Parse the ARM resource ID to extract provider, type, and name
  const resourceIdParts   = resourceToScan.id.split('/')
  const providerNamespace = resourceIdParts[6]
  const resourceTypeName  = resourceIdParts[7]
  const resourceName      = resourceIdParts[8]

  if (!providerNamespace || !resourceTypeName || !resourceName) {
    console.log('[scanResource] ends — invalid ARM ID parts, skipping:', resourceToScan.id)
    return
  }

  const armApiVersion = API_VERSION_MAP[resourceTypeName?.toLowerCase()] || '2021-04-01'
  console.log('[scanResource] using API version:', armApiVersion, 'for type:', resourceTypeName)

  try {
    // ── Live config fetch START ─────────────────────────────────────────────
    console.log('[scanResource liveConfigFetch] starts — resource:', resourceName)
    const liveConfigRaw      = await armClient.resources.get(resourceGroupName, providerNamespace, '', resourceTypeName, resourceName, armApiVersion)
    const liveConfigStripped = strip(liveConfigRaw)
    console.log('[scanResource liveConfigFetch] ends — live config fetched and stripped')
    // ── Live config fetch END ───────────────────────────────────────────────

    // ── Baseline read START ─────────────────────────────────────────────────
    console.log('[scanResource baselineRead] starts — blobKey:', blobKey(resourceToScan.id))
    const baselineDocument = await readBlob(baselinesContainer, blobKey(resourceToScan.id))
    if (!baselineDocument?.resourceState) {
      console.log('[scanResource baselineRead] ends — no baseline found, skipping resource')
      return
    }
    const baselineConfigStripped = strip(baselineDocument.resourceState)
    console.log('[scanResource baselineRead] ends — baseline found and stripped')
    // ── Baseline read END ───────────────────────────────────────────────────

    // ── Diff computation START ──────────────────────────────────────────────
    console.log('[scanResource diffComputation] starts')
    const detectedChanges = diffObjects(baselineConfigStripped, liveConfigStripped)
    const driftSeverity   = classifySeverity(detectedChanges)
    console.log('[scanResource diffComputation] ends — changes:', detectedChanges.length, 'severity:', driftSeverity)
    // ── Diff computation END ────────────────────────────────────────────────

    if (detectedChanges.length === 0) {
      console.log('[scanResource] ends — no drift detected for:', resourceName)
      return  // resource matches baseline — no drift
    }

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

    // ── Drift record write START ────────────────────────────────────────────
    const driftBlobKey = driftKey(resourceToScan.id, detectedAt)
    console.log('[scanResource driftRecordWrite] starts — driftKey:', driftBlobKey)
    await writeBlob(driftRecordsContainer, driftBlobKey, driftRecord)
    console.log('[scanResource driftRecordWrite] ends — drift blob saved')
    // ── Drift record write END ──────────────────────────────────────────────

    // ── driftIndex Table write START ────────────────────────────────────────
    console.log('[scanResource driftIndexWrite] starts')
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
    }, 'Replace').catch(err => {
      console.log('[scanResource driftIndexWrite] upsert failed (non-fatal):', err.message)
    })
    console.log('[scanResource driftIndexWrite] ends — driftIndex entity upserted')
    // ── driftIndex Table write END ──────────────────────────────────────────

    // ── Socket.IO notification START ────────────────────────────────────────
    console.log('[scanResource socketNotification] starts — expressApiUrl:', process.env.EXPRESS_API_URL)
    const expressApiUrl = process.env.EXPRESS_API_URL
    if (expressApiUrl) {
      fetch(`${expressApiUrl}/internal/drift-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(driftRecord),
      }).catch(err => {
        console.log('[scanResource socketNotification] fire-and-forget POST failed:', err.message)
      })
      console.log('[scanResource socketNotification] ends — POST dispatched (fire-and-forget)')
    } else {
      console.log('[scanResource socketNotification] ends — skipped, EXPRESS_API_URL not configured')
    }
    // ── Socket.IO notification END ──────────────────────────────────────────

    context.log(`[scanSubscription] drift: ${driftSeverity} — ${detectedChanges.length} change(s) on ${resourceName}`)
    console.log('[scanResource] ends — drift recorded, severity:', driftSeverity, 'changes:', detectedChanges.length, 'resource:', resourceName)
  } catch (scanError) {
    console.log('[scanResource] ends — caught error for', resourceToScan.id, ':', scanError.message)
    context.log.warn(`[scanSubscription] skip ${resourceToScan.id}: ${scanError.message}`)
  }
}
// ── scanResource END ──────────────────────────────────────────────────────────


// ── Main handler START ────────────────────────────────────────────────────────
// Runs every hour — scans all resources with baselines across all accessible subscriptions
module.exports = async function (context, timer) {
  console.log('[scanSubscription timerHandler] starts')
  if (timer.isPastDue) {
    console.log('[scanSubscription timerHandler] timer is past due — running anyway')
    context.log('[scanSubscription] timer past due — running anyway')
  }

  const azureCredential    = new DefaultAzureCredential()
  const subscriptionClient = new SubscriptionClient(azureCredential)

  // Counters for the summary log at the end
  let subscriptionsScanned = 0, resourcesChecked = 0, driftsRecorded = 0

  try {
    // ── Subscription iteration START ────────────────────────────────────────
    console.log('[scanSubscription subscriptionIteration] starts')
    for await (const subscription of subscriptionClient.subscriptions.list()) {
      const subscriptionId = subscription.subscriptionId
      if (!subscriptionId) continue
      subscriptionsScanned++
      console.log('[scanSubscription subscriptionIteration] processing subscription:', subscriptionId, 'count so far:', subscriptionsScanned)

      const armClient = new ResourceManagementClient(azureCredential, subscriptionId)

      // ── Resource group collection START ───────────────────────────────────
      console.log('[scanSubscription rgCollection] starts — subscriptionId:', subscriptionId)
      const allResourceGroups = []
      for await (const resourceGroup of armClient.resourceGroups.list()) allResourceGroups.push(resourceGroup)
      console.log('[scanSubscription rgCollection] ends — resource groups found:', allResourceGroups.length)
      // ── Resource group collection END ─────────────────────────────────────

      // ── Batch scan START ──────────────────────────────────────────────────
      // Scan resource groups in parallel batches of 5 to avoid ARM throttling
      console.log('[scanSubscription batchScan] starts — scanning', allResourceGroups.length, 'RGs in batches of 5')
      for (let batchStart = 0; batchStart < allResourceGroups.length; batchStart += 5) {
        const resourceGroupBatch = allResourceGroups.slice(batchStart, batchStart + 5)
        console.log('[scanSubscription batchScan] processing batch starting at index:', batchStart, 'size:', resourceGroupBatch.length)
        await Promise.allSettled(resourceGroupBatch.map(async resourceGroup => {
          const resourcesInGroup = []
          for await (const resource of armClient.resources.listByResourceGroup(resourceGroup.name)) resourcesInGroup.push(resource)
          console.log('[scanSubscription batchScan] RG:', resourceGroup.name, 'resources found:', resourcesInGroup.length)
          await Promise.allSettled(resourcesInGroup.map(resource => {
            resourcesChecked++
            return scanResource(context, armClient, subscriptionId, resourceGroup.name, resource)
              .then(() => driftsRecorded++)
              .catch(() => {})
          }))
        }))
      }
      console.log('[scanSubscription batchScan] ends — all batches complete for subscription:', subscriptionId)
      // ── Batch scan END ────────────────────────────────────────────────────
    }
    console.log('[scanSubscription subscriptionIteration] ends — all subscriptions processed')
    // ── Subscription iteration END ──────────────────────────────────────────

  } catch (err) {
    console.log('[scanSubscription timerHandler] caught fatal error:', err.message)
    context.log.error('[scanSubscription] fatal:', err.message)
  }

  context.log(`[scanSubscription] done — ${subscriptionsScanned} subs, ${resourcesChecked} resources checked, ${driftsRecorded} drifts recorded`)
  console.log('[scanSubscription timerHandler] ends — subs:', subscriptionsScanned, 'resources:', resourcesChecked, 'drifts:', driftsRecorded)
}
// ── Main handler END ──────────────────────────────────────────────────────────