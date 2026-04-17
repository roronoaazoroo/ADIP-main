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

const blobSvc  = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
const baseCtr  = blobSvc.getContainerClient('baselines')
const driftCtr = blobSvc.getContainerClient('drift-records')

function getDriftIndex() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'driftIndex')
}

// ── scanResource START ────────────────────────────────────────────────────────
// Fetches live config for one resource, diffs against baseline, writes drift record
async function scanResource(context, armClient, subscriptionId, rgName, resource) {
  const parts      = resource.id.split('/')
  const provider   = parts[6], type = parts[7], name = parts[8]
  if (!provider || !type || !name) return

  const apiVersion = API_VERSION_MAP[type?.toLowerCase()] || '2021-04-01'

  try {
    const liveRaw  = await armClient.resources.get(rgName, provider, '', type, name, apiVersion)
    const live     = strip(liveRaw)
    const baseline = await readBlob(baseCtr, blobKey(resource.id))
    if (!baseline?.resourceState) return // no baseline — skip

    const baseState = strip(baseline.resourceState)
    const changes   = diffObjects(baseState, live)
    const severity  = classifySeverity(changes)

    if (changes.length === 0) return // no drift

    const detectedAt = new Date().toISOString()
    const record = {
      subscriptionId,
      resourceId:    resource.id,
      resourceGroup: rgName,
      liveState:     live,
      baselineState: baseState,
      differences:   changes,
      changes,
      severity,
      changeCount:   changes.length,
      hasPrevious:   true,
      detectedAt,
      source:        'scanSubscription-hourly',
    }

    // Write drift blob
    await writeBlob(driftCtr, driftKey(resource.id, detectedAt), record)

    // Write driftIndex Table entry
    const rk = Buffer.from(driftKey(resource.id, detectedAt)).toString('base64url').slice(0, 512)
    await getDriftIndex().upsertEntity({
      partitionKey:  subscriptionId,
      rowKey:        rk,
      blobKey:       driftKey(resource.id, detectedAt),
      resourceId:    resource.id,
      resourceGroup: rgName,
      severity,
      detectedAt,
      changeCount:   changes.length,
    }, 'Replace').catch(() => {})

    // Notify Express → Socket.IO
    const apiUrl = process.env.EXPRESS_API_URL
    if (apiUrl) {
      fetch(`${apiUrl}/internal/drift-event`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      }).catch(() => {})
    }

    context.log(`[scanSubscription] drift: ${severity} — ${changes.length} change(s) on ${name}`)
  } catch (err) {
    context.log.warn(`[scanSubscription] skip ${resource.id}: ${err.message}`)
  }
}
// ── scanResource END ──────────────────────────────────────────────────────────


// ── Main handler START ────────────────────────────────────────────────────────
// Runs every hour — scans all resources with baselines across all accessible subscriptions
module.exports = async function (context, timer) {
  if (timer.isPastDue) context.log('[scanSubscription] timer past due — running anyway')

  const credential = new DefaultAzureCredential()
  const subClient  = new SubscriptionClient(credential)

  let subCount = 0, resourceCount = 0, driftCount = 0

  try {
    for await (const sub of subClient.subscriptions.list()) {
      const subscriptionId = sub.subscriptionId
      if (!subscriptionId) continue
      subCount++

      const armClient = new ResourceManagementClient(credential, subscriptionId)

      // List all resource groups
      const rgs = []
      for await (const rg of armClient.resourceGroups.list()) rgs.push(rg)

      // Scan each resource group in parallel (batches of 5)
      for (let i = 0; i < rgs.length; i += 5) {
        const batch = rgs.slice(i, i + 5)
        await Promise.allSettled(batch.map(async rg => {
          const resources = []
          for await (const r of armClient.resources.listByResourceGroup(rg.name)) resources.push(r)
          await Promise.allSettled(resources.map(r => {
            resourceCount++
            return scanResource(context, armClient, subscriptionId, rg.name, r)
              .then(() => driftCount++)
              .catch(() => {})
          }))
        }))
      }
    }
  } catch (err) {
    context.log.error('[scanSubscription] fatal:', err.message)
  }

  context.log(`[scanSubscription] done — ${subCount} subs, ${resourceCount} resources checked, ${driftCount} drifts recorded`)
}
// ── Main handler END ──────────────────────────────────────────────────────────
