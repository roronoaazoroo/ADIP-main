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

// Connect to Azure Blob Storage
const blobStorageClient     = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
const baselinesContainer    = blobStorageClient.getContainerClient('baselines')     // golden baseline blobs
const driftRecordsContainer = blobStorageClient.getContainerClient('drift-records') // detected drift blobs

// Returns a Table Storage client for the monitorSessions table
// Each row = one active monitoring session started by a user on the DriftScanner page
function getMonitorSessionsTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'monitorSessions')
}

// Returns a Table Storage client for the driftIndex table
// Each row = one detected drift event, used for fast queries by /api/drift-events
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
      let apiVersion = API_VERSION_MAP[type?.toLowerCase()]
      if (!apiVersion) {
        try {
          const providerInfo = await armClient.providers.get(provider)
          const rt = providerInfo.resourceTypes?.find(r => r.resourceType?.toLowerCase() === type?.toLowerCase())
          apiVersion = rt?.apiVersions?.find(v => !v.includes('preview')) || rt?.apiVersions?.[0] || '2021-04-01'
        } catch { apiVersion = '2021-04-01' }
      }
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
    const baselineDocument       = await readBlob(baselinesContainer, blobKey(resourceId || resourceGroupId))
    const baselineConfigStripped = baselineDocument ? strip(baselineDocument.resourceState) : null
    const detectedChanges        = baselineConfigStripped ? diffObjects(baselineConfigStripped, live) : []
    const driftSeverity          = classifySeverity(detectedChanges)

    if (detectedChanges.length === 0) {
      context.log(`[monitorResources] no drift — ${resourceId || resourceGroupId}`)
      return
    }

    const detectedAt = new Date().toISOString()
    const driftRecord = {
      subscriptionId,
      resourceId:    resourceId || resourceGroupId,
      resourceGroup: resourceGroupId,
      liveState:     live,
      baselineState: baselineConfigStripped,
      differences:   detectedChanges,
      changes:       detectedChanges,
      severity:      driftSeverity,
      changeCount:   detectedChanges.length,
      hasPrevious:   !!baselineConfigStripped,
      detectedAt,
      source:        'monitorResources-timer',  // identifies this came from the 1-min timer function
    }

    // Save the drift record blob to 'drift-records' container
    await writeBlob(driftRecordsContainer, driftKey(driftRecord.resourceId, detectedAt), driftRecord)

    // Write a lightweight index row to driftIndex Table for fast queries
    try {
      const driftIndexTable = getDriftIndexTable()
      const driftBlobKey    = driftKey(driftRecord.resourceId, detectedAt)
      const tableRowKey     = Buffer.from(driftBlobKey).toString('base64url').slice(0, 512)
      await driftIndexTable.upsertEntity({
        partitionKey:  subscriptionId,
        rowKey:        tableRowKey,
        blobKey:       driftBlobKey,
        resourceId:    driftRecord.resourceId,
        resourceGroup: resourceGroupId,
        severity:      driftSeverity,
        detectedAt,
        changeCount:   detectedChanges.length,
      }, 'Replace')
    } catch (e) {
      context.log.warn('[monitorResources] driftIndex write failed:', e.message)
    }

    // Notify the Express API so it can push the event to the browser via Socket.IO
    const expressApiUrl = process.env.EXPRESS_API_URL
    if (expressApiUrl) {
      fetch(`${expressApiUrl}/internal/drift-event`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(driftRecord),
      }).catch(() => {})  // fire-and-forget
    }

    context.log(`[monitorResources] drift detected — ${driftSeverity} — ${detectedChanges.length} change(s) on ${driftRecord.resourceId}`)
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

  const monitorSessionsTable = getMonitorSessionsTable()
  const activeSessions = []

  try {
    // Query monitorSessions Table for all sessions where active = true
    for await (const sessionEntity of monitorSessionsTable.listEntities({ queryOptions: { filter: "active eq true" } })) {
      activeSessions.push({
        subscriptionId:  sessionEntity.subscriptionId,
        resourceGroupId: sessionEntity.resourceGroupId,
        resourceId:      sessionEntity.resourceId || null,
        intervalMs:      sessionEntity.intervalMs || 60000,   // how often to check this session
        lastCheckedAt:   sessionEntity.lastCheckedAt || null,  // when it was last checked
      })
    }
  } catch (err) {
    context.log.error('[monitorResources] failed to read sessions:', err.message)
    return
  }

  if (activeSessions.length === 0) {
    context.log('[monitorResources] no active sessions')
    return
  }

  context.log(`[monitorResources] checking ${activeSessions.length} session(s)`)

  // Only run drift checks for sessions whose check interval has elapsed
  // e.g. if intervalMs = 300000 (5 min), skip sessions checked less than 5 min ago
  const currentTimeMs = Date.now()
  const sessionsDue   = activeSessions.filter(session => {
    if (!session.lastCheckedAt) return true  // never checked — always run
    const timeSinceLastCheck = currentTimeMs - new Date(session.lastCheckedAt).getTime()
    return timeSinceLastCheck >= (session.intervalMs || 60000)
  })
  context.log(`[monitorResources] ${sessionsDue.length} of ${activeSessions.length} session(s) due`)
  await Promise.allSettled(sessionsDue.map(session => runDriftCheck(context, session)))

  // Update lastCheckedAt timestamp for all sessions so the interval logic works next run
  const currentTimestamp = new Date().toISOString()
  await Promise.allSettled(activeSessions.map(session => {
    const sessionKey = `${session.subscriptionId}:${session.resourceGroupId}:${session.resourceId || ''}`
    return monitorSessionsTable.upsertEntity({
      partitionKey:    'session',
      rowKey:          Buffer.from(sessionKey).toString('base64url').slice(0, 512),
      subscriptionId:  session.subscriptionId,
      resourceGroupId: session.resourceGroupId,
      resourceId:      session.resourceId || '',
      intervalMs:      session.intervalMs,
      active:          true,
      lastCheckedAt:   currentTimestamp,
    }, 'Merge').catch(() => {})
  }))
}
// ── Timer handler END ─────────────────────────────────────────────────────────
