// ============================================================
// FILE: adip-backend/express-api/src/services/queuePoller.js
// ROLE: Event processing pipeline — polls Storage Queue, enriches,
//       persists, classifies, and emits to Socket.IO
//
// Architecture:
//   poll() → parse() → deduplicate() → enrich() → persist() → classify() → emit()
//
// Each stage is isolated and independently testable.
// Failures in non-critical stages (persist, classify) don't block emission.
// ============================================================
'use strict'
const { QueueServiceClient } = require('@azure/storage-queue')
const { TableClient } = require('@azure/data-tables')
const { strip, diffObjects } = require('../shared/diff')
const { resolveIdentity } = require('../shared/identity')
const { classifySeverity } = require('../shared/severity')
const { getResourceConfig } = require('./azureResourceService')

let _blobService = null
function blob() { if (!_blobService) _blobService = require('./blobService'); return _blobService }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STAGE 1: Queue Client
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let _queueClient = null
function getQueueClient() {
  if (!_queueClient) {
    _queueClient = QueueServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
      .getQueueClient(process.env.STORAGE_QUEUE_NAME || 'resource-changes')
  }
  return _queueClient
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STAGE 2: Parse — decode queue message into structured event
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function parse(msg) {
  try {
    const raw = JSON.parse(Buffer.from(msg.messageText, 'base64').toString('utf-8'))
    const event = Array.isArray(raw) ? raw[0] : raw

    // Skip system-generated action events (no human operator)
    if ((event.eventType || '').includes('ResourceActionSuccess')) return null

    let resourceId = event.data?.resourceUri || event.subject || ''
    resourceId = resourceId.replace(/\/resourcegroups\//i, '/resourceGroups/')

    // Normalize child resources to parent (e.g., blobServices/default → storageAccounts/foo)
    const parts = resourceId.split('/')
    if (parts.length > 9) resourceId = parts.slice(0, 9).join('/')

    const uriParts = resourceId.split('/')
    const claims = event.data?.claims || {}

    return {
      eventId: event.id,
      eventType: event.eventType,
      eventTime: event.eventTime || new Date().toISOString(),
      resourceId,
      subscriptionId: uriParts[2] || '',
      resourceGroup: uriParts.length >= 5 ? uriParts[4] : '',
      operationName: event.data?.operationName || event.eventType,
      status: event.data?.status || 'Succeeded',
      caller: claims.name
        || claims['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name']
        || claims.unique_name
        || claims['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn']
        || event.data?.caller
        || 'System',
      isRgLevel: uriParts.length <= 5,
      isDelete: (event.eventType || '').includes('Delete'),
    }
  } catch {
    return null
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STAGE 3: Deduplicate — same resource+operation within 100ms = same event
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const _seen = new Map()
function isDuplicate(event) {
  const bucket = Math.floor(new Date(event.eventTime).getTime() / 100)
  const key = `${event.resourceId}:${event.operationName}:${bucket}`
  if (_seen.has(key)) return true
  _seen.set(key, Date.now())
  // Cleanup every 1000 entries
  if (_seen.size > 1000) {
    const cutoff = Date.now() - 60000
    for (const [k, ts] of _seen) { if (ts < cutoff) _seen.delete(k) }
  }
  return false
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STAGE 4: State Cache — in-memory + Table Storage for diff computation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const _cache = {}
let _cacheTable = null
function cacheTable() {
  if (!_cacheTable) _cacheTable = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'liveStateCache')
  return _cacheTable
}
function cacheKey(id) { return Buffer.from(id).toString('base64').replace(/[/\\#?]/g, '_').slice(0, 200) }

async function cacheGet(resourceId) {
  if (_cache[resourceId]) return _cache[resourceId]
  try {
    const e = await cacheTable().getEntity('state', cacheKey(resourceId))
    if (e?.stateJson) { _cache[resourceId] = JSON.parse(e.stateJson); return _cache[resourceId] }
  } catch {}
  return null
}

async function cacheSet(resourceId, state) {
  if (!state) return
  _cache[resourceId] = state
  cacheTable().upsertEntity({ partitionKey: 'state', rowKey: cacheKey(resourceId), stateJson: JSON.stringify(state) }, 'Replace').catch(() => {})
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STAGE 5: Enrich — fetch live ARM state, compute diff, resolve caller
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function fetchRgConfig(subscriptionId, resourceGroup) {
  const { ResourceManagementClient } = require('@azure/arm-resources')
  const { DefaultAzureCredential } = require('@azure/identity')
  const client = new ResourceManagementClient(new DefaultAzureCredential(), subscriptionId)
  const rg = await client.resourceGroups.get(resourceGroup)
  return { name: rg.name, location: rg.location, tags: rg.tags || {}, properties: rg.properties || {}, managedBy: rg.managedBy || '' }
}

async function enrich(event) {
  if (!event.resourceId || !event.subscriptionId || !event.resourceGroup) return event

  const [liveRaw, resolvedCaller] = await Promise.all([
    event.isRgLevel
      ? fetchRgConfig(event.subscriptionId, event.resourceGroup).catch(() => null)
      : getResourceConfig(event.subscriptionId, event.resourceGroup, event.resourceId).catch(() => null),
    resolveIdentity(event.caller),
  ])

  const current = strip(liveRaw)
  const previous = await cacheGet(event.resourceId)
    || await blob().getBaseline(event.subscriptionId, event.resourceId).then(b => b?.resourceState ? strip(b.resourceState) : null).catch(() => null)

  const changes = (previous && current) ? diffObjects(previous, current) : []
  if (current) await cacheSet(event.resourceId, current)

  return {
    ...event,
    caller: resolvedCaller || event.caller,
    liveState: current,
    changes,
    changeCount: changes.length,
    hasPrevious: !!previous,
    severity: changes.length > 0 ? classifySeverity(changes) : (event.isDelete ? 'critical' : 'low'),
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STAGE 6: Persist — save to changesIndex, driftIndex, genome
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function persist(event) {
  const tasks = []

  // 6a. Always save to changesIndex (audit log)
  tasks.push(
    blob().saveChangeRecord({
      subscriptionId: event.subscriptionId,
      resourceId: event.resourceId,
      resourceGroup: event.resourceGroup,
      eventType: event.eventType,
      operationName: event.operationName,
      changeType: event.isDelete ? 'deleted' : 'modified',
      caller: event.caller,
      detectedAt: event.eventTime,
      changeCount: event.changeCount || 0,
      changeSummary: buildSummary(event),
      source: 'queue-poller',
    }).catch(() => {})
  )

  // 6b. Save drift record if changes detected against baseline
  if (event.changes?.length > 0 && event.hasPrevious) {
    tasks.push(
      blob().saveDriftRecord({
        subscriptionId: event.subscriptionId,
        resourceId: event.resourceId,
        resourceGroup: event.resourceGroup,
        differences: event.changes,
        severity: event.severity,
        changeCount: event.changes.length,
        caller: event.caller,
        detectedAt: event.eventTime,
        liveState: event.liveState,
      }).catch(() => {})
    )
  }

  // 6c. Save drift record for deletions
  if (event.isDelete) {
    tasks.push(
      blob().saveDriftRecord({
        subscriptionId: event.subscriptionId,
        resourceId: event.resourceId,
        resourceGroup: event.resourceGroup,
        differences: [{ type: 'removed', path: 'resource', oldValue: 'exists', newValue: 'deleted' }],
        severity: 'critical',
        changeCount: 1,
        caller: event.caller,
        detectedAt: event.eventTime,
        eventType: 'deleted',
      }).catch(() => {})
    )
    // Pre-deletion snapshot for recovery
    const prev = await cacheGet(event.resourceId)
    if (prev) blob().savePreDeletionSnapshot(event.subscriptionId, event.resourceId, prev, event.caller).catch(() => {})
  }

  // 6d. Auto-save genome snapshot
  if (event.liveState && event.resourceId) {
    const label = `change-${(event.eventTime || new Date().toISOString()).replace(/[:.]/g, '-')}`
    const category = categorizeLocal(event.changes || [])
    tasks.push(
      blob().saveGenomeSnapshot(event.subscriptionId, event.resourceId, event.liveState, label, 30, 'change', event.caller, category).catch(() => {})
    )
  }

  await Promise.allSettled(tasks)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STAGE 7: Emit — broadcast to Socket.IO rooms
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function emit(event) {
  if (!global.io) return

  const rgRoom = event.resourceGroup ? `${event.subscriptionId}:${event.resourceGroup}`.toLowerCase() : null
  const resName = event.resourceId?.split('/').pop()?.toLowerCase()

  const rooms = [
    event.subscriptionId?.toLowerCase(),
    rgRoom,
    rgRoom && resName && resName !== event.resourceGroup?.toLowerCase() ? `${rgRoom}:${resName}` : null,
  ].filter(Boolean)

  rooms.forEach(room => global.io.to(room).emit('resourceChange', event))
  if (global._markEmitted) global._markEmitted(event)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// STAGE 8: Route to Orchestrator (if available)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function routeToOrchestrator(event) {
  try {
    const { EventRouter } = require('../orchestrator')
    EventRouter.process({
      tenantId: event.tenantId || 'default',
      subscriptionId: event.subscriptionId,
      resourceGroup: event.resourceGroup,
      resourceId: event.resourceId,
      type: event.isDelete ? 'resource.deleted' : 'drift.detected',
      severity: event.severity,
      changes: event.changes,
      caller: event.caller,
      timestamp: event.eventTime,
    }).catch(() => {})
  } catch {}
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN LOOP
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function startQueuePoller() {
  const interval = parseInt(process.env.QUEUE_POLL_INTERVAL_MS || '5000', 10)
  const client = getQueueClient()
  let processing = false

  setInterval(async () => {
    if (processing) return
    processing = true

    try {
      const { receivedMessageItems } = await client.receiveMessages({ numberOfMessages: 32, visibilityTimeout: 300 })

      for (const msg of receivedMessageItems) {
        // Parse
        const event = parse(msg)
        if (!event) { await client.deleteMessage(msg.messageId, msg.popReceipt).catch(() => {}); continue }
        if (isDuplicate(event)) { await client.deleteMessage(msg.messageId, msg.popReceipt).catch(() => {}); continue }

        try {
          // Enrich
          const enriched = await enrich(event)

          // Delete from queue (event accepted)
          await client.deleteMessage(msg.messageId, msg.popReceipt)

          // Emit immediately (don't wait for persist)
          emit(enriched)

          // Persist in background (non-blocking)
          persist(enriched).catch(() => {})

          // Route to orchestrator (non-blocking)
          routeToOrchestrator(enriched)

        } catch (err) {
          // Enrichment failed — still emit basic event so feed isn't silent
          emit(event)
          await client.deleteMessage(msg.messageId, msg.popReceipt).catch(() => {})
        }
      }
    } catch (pollErr) {
      console.error('[QueuePoller] poll error:', pollErr.message)
    }

    processing = false
  }, interval)

  console.log(`[QueuePoller] Started — ${interval}ms interval`)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HELPERS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function buildSummary(event) {
  const changes = (event.changes || []).slice(0, 5)
  const resource = (event.resourceId || '').split('/').pop() || 'resource'
  return changes.filter(c => {
    const p = (c.path || '').toLowerCase()
    return !p.includes('_childconfig') && !p.includes('storagetables') && !p.includes('storagequeues') && !p.includes('storagecontainers')
  }).map(c => {
    const field = (c.path || '').split(' → ').pop() || ''
    if ((c.path || '').toLowerCase().includes('tag')) {
      if (c.type === 'removed') return `removed tag "${field}" from ${resource}`
      if (c.type === 'added') return `added tag ${field}: ${String(c.newValue ?? '').slice(0, 20)} on ${resource}`
      return `updated tag ${field} on ${resource}`
    }
    if (c.type === 'removed') return `removed ${field} from ${resource}`
    if (c.type === 'added') return `added ${field} to ${resource}`
    return `changed ${field} on ${resource}`
  }).join('. ')
}

function categorizeLocal(changes) {
  const paths = changes.map(c => (c.path || '').toLowerCase()).join(' ')
  const cats = []
  if (/network|subnet|firewall|iprule|virtualnetwork|defaultaction/.test(paths)) cats.push('Network')
  if (/security|encryption|tls|https|accesspolic|keysource/.test(paths)) cats.push('Security')
  if (/tag/.test(paths)) cats.push('Tags')
  if (/sku|tier|capacity/.test(paths)) cats.push('SKU')
  if (/identity|managedidentity|principalid/.test(paths)) cats.push('Identity')
  if (cats.length === 0) cats.push('Configuration')
  return cats.join(',')
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// EXPORTS
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

module.exports = { startQueuePoller, liveStateCache: _cache }
