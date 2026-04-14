require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') })
const { TableClient }              = require('@azure/data-tables')
const { ResourceManagementClient } = require('@azure/arm-resources')
const { DefaultAzureCredential }   = require('@azure/identity')
const { BlobServiceClient }        = require('@azure/storage-blob')
const fetch                        = require('node-fetch')

const { strip, diffObjects }       = require('adip-shared/diff')
const { classifySeverity }         = require('adip-shared/severity')
const { blobKey, driftKey, readBlob, writeBlob } = require('adip-shared/blobHelpers')
const { API_VERSION_MAP }          = require('adip-shared/constants')

const blobService = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
const baselineCtr = blobService.getContainerClient('baselines')
const driftCtr    = blobService.getContainerClient('drift-records')

function getSessionTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'monitorSessions')
}

function getDriftIndexTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'driftIndex')
}

// ── runDriftCheck START ───────────────────────────────────────────────────────
// Fetches live ARM config, diffs against baseline, saves drift record, notifies Express
async function runDriftCheck(context, session) {
  const { subscriptionId, resourceGroupId, resourceId } = session

  try {
    const credential = new DefaultAzureCredential()
    const armClient  = new ResourceManagementClient(credential, subscriptionId)

    let liveRaw
    if (resourceId && resourceId.startsWith('/subscriptions/')) {
      const parts      = resourceId.split('/')
      const rgName     = parts[4], provider = parts[6], type = parts[7], name = parts[8]
      const apiVersion = API_VERSION_MAP[type?.toLowerCase()] || '2021-04-01'
      liveRaw = await armClient.resources.get(rgName, provider, '', type, name, apiVersion)
    } else {
      // Resource group level — list all resources
      const resources = []
      for await (const r of armClient.resources.listByResourceGroup(resourceGroupId, { expand: 'properties' })) {
        resources.push(r)
      }
      const rg = await armClient.resourceGroups.get(resourceGroupId)
      liveRaw = { resourceGroup: rg, resources }
    }

    const live      = strip(liveRaw)
    const baseline  = await readBlob(baselineCtr, blobKey(resourceId || resourceGroupId))
    const baseState = baseline ? strip(baseline.resourceState) : null
    const changes   = baseState ? diffObjects(baseState, live) : []
    const severity  = classifySeverity(changes)

    if (changes.length === 0) {
      context.log(`[monitorResources] no drift — ${resourceId || resourceGroupId}`)
      return
    }

    const detectedAt = new Date().toISOString()
    const record = {
      subscriptionId,
      resourceId:    resourceId || resourceGroupId,
      resourceGroup: resourceGroupId,
      liveState:     live,
      baselineState: baseState,
      differences:   changes,
      changes,
      severity,
      changeCount:   changes.length,
      hasPrevious:   !!baseState,
      detectedAt,
      source:        'monitorResources-timer',
    }

    // Save drift record blob
    await writeBlob(driftCtr, driftKey(record.resourceId, detectedAt), record)

    // Write to driftIndex Table
    try {
      const tc = getDriftIndexTable()
      const rk = Buffer.from(driftKey(record.resourceId, detectedAt)).toString('base64url').slice(0, 512)
      await tc.upsertEntity({
        partitionKey:  subscriptionId,
        rowKey:        rk,
        blobKey:       driftKey(record.resourceId, detectedAt),
        resourceId:    record.resourceId,
        resourceGroup: resourceGroupId,
        severity,
        detectedAt,
        changeCount:   changes.length,
      }, 'Replace')
    } catch (e) {
      context.log.warn('[monitorResources] driftIndex write failed:', e.message)
    }

    // Notify Express → Socket.IO
    const apiUrl = process.env.EXPRESS_API_URL
    if (apiUrl) {
      fetch(`${apiUrl}/internal/drift-event`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(record),
      }).catch(() => {})
    }

    context.log(`[monitorResources] drift detected — ${severity} — ${changes.length} change(s) on ${record.resourceId}`)
  } catch (err) {
    context.log.error(`[monitorResources] error for ${resourceId || resourceGroupId}:`, err.message)
  }
}
// ── runDriftCheck END ─────────────────────────────────────────────────────────


// ── Timer handler START ───────────────────────────────────────────────────────
// Runs every minute, reads all active monitor sessions from Table Storage, checks each one
module.exports = async function (context, timer) {
  if (timer.isPastDue) {
    context.log('[monitorResources] timer is past due — running anyway')
  }

  const tc = getSessionTable()
  const sessions = []

  try {
    for await (const entity of tc.listEntities({ queryOptions: { filter: "active eq true" } })) {
      sessions.push({
        subscriptionId: entity.subscriptionId,
        resourceGroupId: entity.resourceGroupId,
        resourceId:     entity.resourceId || null,
        intervalMs:     entity.intervalMs || 60000,
        lastCheckedAt:  entity.lastCheckedAt || null,
      })
    }
  } catch (err) {
    context.log.error('[monitorResources] failed to read sessions:', err.message)
    return
  }

  if (sessions.length === 0) {
    context.log('[monitorResources] no active sessions')
    return
  }

  context.log(`[monitorResources] checking ${sessions.length} session(s)`)

  // Run all checks in parallel
  await Promise.allSettled(sessions.map(s => runDriftCheck(context, s)))

  // Update lastCheckedAt for all sessions
  const now = new Date().toISOString()
  await Promise.allSettled(sessions.map(s => {
    const rk = `${s.subscriptionId}:${s.resourceGroupId}:${s.resourceId || ''}`
    return tc.upsertEntity({
      partitionKey:   'session',
      rowKey:         Buffer.from(rk).toString('base64url').slice(0, 512),
      subscriptionId: s.subscriptionId,
      resourceGroupId: s.resourceGroupId,
      resourceId:     s.resourceId || '',
      intervalMs:     s.intervalMs,
      active:         true,
      lastCheckedAt:  now,
    }, 'Merge').catch(() => {})
  }))
}
// ── Timer handler END ─────────────────────────────────────────────────────────
