'use strict'
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
  console.log('[getMonitorSessionsTable] starts')
  const client = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'monitorSessions')
  console.log('[getMonitorSessionsTable] ends')
  return client
}

// Returns a Table Storage client for the driftIndex table
// Each row = one detected drift event, used for fast queries by /api/drift-events
function getDriftIndexTable() {
  console.log('[getDriftIndexTable] starts')
  const client = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'driftIndex')
  console.log('[getDriftIndexTable] ends')
  return client
}

// ── runDriftCheck START ───────────────────────────────────────────────────────
// Fetches live ARM config, diffs against baseline, saves drift record, notifies Express
async function runDriftCheck(context, session) {
  console.log('[runDriftCheck] starts — subscriptionId:', session.subscriptionId, 'resourceId:', session.resourceId || session.resourceGroupId)
  const { subscriptionId, resourceGroupId, resourceId } = session

  try {
    const credential = new DefaultAzureCredential()
    const armClient  = new ResourceManagementClient(credential, subscriptionId)

    // ── Live config fetch START ─────────────────────────────────────────────
    console.log('[runDriftCheck liveConfigFetch] starts — resourceId:', resourceId || 'RG-level:' + resourceGroupId)
    let liveRaw
    if (resourceId && resourceId.startsWith('/subscriptions/')) {
      const parts    = resourceId.split('/')
      const rgName   = parts[4], provider = parts[6], type = parts[7], name = parts[8]
      let apiVersion = API_VERSION_MAP[type?.toLowerCase()]
      if (!apiVersion) {
        console.log('[runDriftCheck liveConfigFetch] API version not in map — querying ARM providers for type:', type)
        try {
          const providerInfo = await armClient.providers.get(provider)
          const rt = providerInfo.resourceTypes?.find(r => r.resourceType?.toLowerCase() === type?.toLowerCase())
          apiVersion = rt?.apiVersions?.find(v => !v.includes('preview')) || rt?.apiVersions?.[0] || '2021-04-01'
          console.log('[runDriftCheck liveConfigFetch] API version resolved from ARM:', apiVersion)
        } catch (e) {
          apiVersion = '2021-04-01'
          console.log('[runDriftCheck liveConfigFetch] ARM providers query failed — using fallback:', apiVersion, 'error:', e.message)
        }
      } else {
        console.log('[runDriftCheck liveConfigFetch] API version found in static map:', apiVersion)
      }
      liveRaw = await armClient.resources.get(rgName, provider, '', type, name, apiVersion)
    } else {
      // Resource group level — list all resources
      console.log('[runDriftCheck liveConfigFetch] fetching RG-level config for:', resourceGroupId)
      const resources = []
      for await (const r of armClient.resources.listByResourceGroup(resourceGroupId, { expand: 'properties' })) {
        resources.push(r)
      }
      const rg = await armClient.resourceGroups.get(resourceGroupId)
      liveRaw = { resourceGroup: rg, resources }
      console.log('[runDriftCheck liveConfigFetch] RG-level fetch complete — resources found:', resources.length)
    }
    console.log('[runDriftCheck liveConfigFetch] ends')
    // ── Live config fetch END ───────────────────────────────────────────────

    const live = strip(liveRaw)

    // ── Baseline read START ─────────────────────────────────────────────────
    console.log('[runDriftCheck baselineRead] starts — blobKey:', blobKey(resourceId || resourceGroupId))
    const baselineDocument       = await readBlob(baselinesContainer, blobKey(resourceId || resourceGroupId))
    const baselineConfigStripped = baselineDocument ? strip(baselineDocument.resourceState) : null
    console.log('[runDriftCheck baselineRead] ends — baseline found:', !!baselineDocument)
    // ── Baseline read END ───────────────────────────────────────────────────

    // ── Diff computation START ──────────────────────────────────────────────
    console.log('[runDriftCheck diffComputation] starts')
    const detectedChanges = baselineConfigStripped ? diffObjects(baselineConfigStripped, live) : []
    const driftSeverity   = classifySeverity(detectedChanges)
    console.log('[runDriftCheck diffComputation] ends — changes:', detectedChanges.length, 'severity:', driftSeverity)
    // ── Diff computation END ────────────────────────────────────────────────

    if (detectedChanges.length === 0) {
      console.log('[runDriftCheck] ends — no drift detected for:', resourceId || resourceGroupId)
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

    // ── Drift record write START ────────────────────────────────────────────
    console.log('[runDriftCheck driftRecordWrite] starts — driftKey:', driftKey(driftRecord.resourceId, detectedAt))
    await writeBlob(driftRecordsContainer, driftKey(driftRecord.resourceId, detectedAt), driftRecord)
    console.log('[runDriftCheck driftRecordWrite] ends — drift blob saved')
    // ── Drift record write END ──────────────────────────────────────────────

    // ── driftIndex Table write START ────────────────────────────────────────
    console.log('[runDriftCheck driftIndexWrite] starts')
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
      console.log('[runDriftCheck driftIndexWrite] ends — driftIndex entity upserted')
    } catch (e) {
      console.log('[runDriftCheck driftIndexWrite] ends — driftIndex write failed:', e.message)
      context.log.warn('[monitorResources] driftIndex write failed:', e.message)
    }
    // ── driftIndex Table write END ──────────────────────────────────────────

    // ── Socket.IO notification START ────────────────────────────────────────
    console.log('[runDriftCheck socketNotification] starts — expressApiUrl:', process.env.EXPRESS_API_URL)
    const expressApiUrl = process.env.EXPRESS_API_URL
    if (expressApiUrl) {
      fetch(`${expressApiUrl}/internal/drift-event`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(driftRecord),
      }).catch(err => {
        console.log('[runDriftCheck socketNotification] fire-and-forget POST failed:', err.message)
      })
      console.log('[runDriftCheck socketNotification] ends — POST dispatched (fire-and-forget)')
    } else {
      console.log('[runDriftCheck socketNotification] ends — skipped, EXPRESS_API_URL not configured')
    }
    // ── Socket.IO notification END ──────────────────────────────────────────

    context.log(`[monitorResources] drift detected — ${driftSeverity} — ${detectedChanges.length} change(s) on ${driftRecord.resourceId}`)
    console.log('[runDriftCheck] ends — drift recorded, severity:', driftSeverity, 'changes:', detectedChanges.length)
  } catch (err) {
    console.log('[runDriftCheck] ends — caught error for', resourceId || resourceGroupId, ':', err.message)
    context.log.error(`[monitorResources] error for ${resourceId || resourceGroupId}:`, err.message)
  }
}
// ── runDriftCheck END ─────────────────────────────────────────────────────────


// ── Timer handler START ───────────────────────────────────────────────────────
// Runs every minute, reads all active monitor sessions from Table Storage, checks each one
module.exports = async function (context, timer) {
  console.log('[monitorResources timerHandler] starts')
  if (timer.isPastDue) {
    console.log('[monitorResources timerHandler] timer is past due — running anyway')
    context.log('[monitorResources] timer is past due — running anyway')
  }

  const monitorSessionsTable = getMonitorSessionsTable()
  const activeSessions = []

  // ── Session fetch START ───────────────────────────────────────────────────
  console.log('[monitorResources sessionFetch] starts')
  try {
    for await (const sessionEntity of monitorSessionsTable.listEntities({ queryOptions: { filter: 'active eq true' } })) {
      activeSessions.push({
        subscriptionId:  sessionEntity.subscriptionId,
        resourceGroupId: sessionEntity.resourceGroupId,
        resourceId:      sessionEntity.resourceId || null,
        intervalMs:      sessionEntity.intervalMs || 60000,   // how often to check this session
        lastCheckedAt:   sessionEntity.lastCheckedAt || null,  // when it was last checked
      })
    }
    console.log('[monitorResources sessionFetch] ends — active sessions found:', activeSessions.length)
  } catch (err) {
    console.log('[monitorResources sessionFetch] ends — failed to read sessions:', err.message)
    context.log.error('[monitorResources] failed to read sessions:', err.message)
    console.log('[monitorResources timerHandler] ends — aborted due to session fetch error')
    return
  }
  // ── Session fetch END ─────────────────────────────────────────────────────

  if (activeSessions.length === 0) {
    console.log('[monitorResources timerHandler] ends — no active sessions found')
    context.log('[monitorResources] no active sessions')
    return
  }

  context.log(`[monitorResources] checking ${activeSessions.length} session(s)`)

  // ── Due session filter START ──────────────────────────────────────────────
  // Only run drift checks for sessions whose check interval has elapsed
  // e.g. if intervalMs = 300000 (5 min), skip sessions checked less than 5 min ago
  console.log('[monitorResources dueSessionFilter] starts')
  const currentTimeMs = Date.now()
  const sessionsDue   = activeSessions.filter(session => {
    if (!session.lastCheckedAt) return true  // never checked — always run
    const timeSinceLastCheck = currentTimeMs - new Date(session.lastCheckedAt).getTime()
    return timeSinceLastCheck >= (session.intervalMs || 60000)
  })
  console.log('[monitorResources dueSessionFilter] ends — sessions due:', sessionsDue.length, 'of', activeSessions.length)
  // ── Due session filter END ────────────────────────────────────────────────

  context.log(`[monitorResources] ${sessionsDue.length} of ${activeSessions.length} session(s) due`)

  // ── Drift checks START ────────────────────────────────────────────────────
  console.log('[monitorResources driftChecks] starts — running', sessionsDue.length, 'checks in parallel')
  await Promise.allSettled(sessionsDue.map(session => runDriftCheck(context, session)))
  console.log('[monitorResources driftChecks] ends — all checks settled')
  // ── Drift checks END ──────────────────────────────────────────────────────

  // ── lastCheckedAt update START ────────────────────────────────────────────
  // Update lastCheckedAt timestamp for all sessions so the interval logic works next run
  console.log('[monitorResources lastCheckedAtUpdate] starts — updating', activeSessions.length, 'session(s)')
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
    }, 'Merge').catch(err => {
      console.log('[monitorResources lastCheckedAtUpdate] upsert failed for session:', sessionKey, 'error:', err.message)
    })
  }))
  console.log('[monitorResources lastCheckedAtUpdate] ends — all session timestamps updated')
  // ── lastCheckedAt update END ──────────────────────────────────────────────

  console.log('[monitorResources timerHandler] ends')
}
// ── Timer handler END ─────────────────────────────────────────────────────────