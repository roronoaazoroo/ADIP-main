// FILE: adip-backend/express-api/src/services/queuePoller.js
// ROLE: Real-time change feed engine — polls Azure Storage Queue and pushes events to the browser
// What this file owns:

//   - startQueuePoller(): reads the 'resource-changes' queue every 5s
//   - parseMessage(): decodes raw Event Grid queue messages into structured event objects
//   - enrichWithDiff(): fetches live ARM config, diffs against previous state,
//     returns the event with changes[], liveState, and resolved caller identity
//   - isDuplicate(): deduplicates events within a 100ms time bucket to prevent double-emit
//   - liveStateCache: a Proxy over an in-memory object that also persists to
//     Azure Table Storage ('liveStateCache' table) so diffs survive Express restarts
//   - saveChangeRecord(): called after each event to write to 'all-changes' blob
//     and 'changesIndex' Table (permanent audit log)

// Called by: app.js on server start via startQueuePoller()
// Emits to:  global.io Socket.IO rooms (subscriptionId:resourceGroup:resourceName)

'use strict'
const { QueueServiceClient } = require('@azure/storage-queue')
const { TableClient }        = require('@azure/data-tables')
const { strip, diffObjects } = require('../shared/diff')
const { resolveIdentity }    = require('../shared/identity')
const { classifySeverity }   = require('../shared/severity')
const { getResourceConfig }  = require('./azureResourceService')
// blobService required lazily below to avoid circular dependency at module load time
// (blobService → queuePoller would create a cycle if required at top level)
let _blobService = null
function getBlobServiceModule() {
  if (!_blobService) _blobService = require('./blobService')
  return _blobService
}

//  Queue client 
let _queueClient = null
function getQueueClient() {
  if (!_queueClient) {
    if (!process.env.STORAGE_CONNECTION_STRING) throw new Error('STORAGE_CONNECTION_STRING is not set')
    const svc = QueueServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
    _queueClient = svc.getQueueClient(process.env.STORAGE_QUEUE_NAME || 'resource-changes')
  }
  return _queueClient
}
//  getQueueClient END 


//  Persistent state cache (Azure Table Storage + in-memory L1) 
const _mem = {}
let _tableClient = null
function getTableClient() {
  if (!_tableClient) {
    try {
      _tableClient = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'liveStateCache')
    } catch (tableInitError) {
      console.error('[queuePoller] failed to init liveStateCache Table client:', tableInitError.message)
    }
  }
  return _tableClient
}
function cacheKey(id) { return Buffer.from(id).toString('base64').replace(/[/\\#?]/g, '_') }

async function cacheGet(resourceId) {
  if (_mem[resourceId]) return _mem[resourceId]
  try {
    const e = await getTableClient()?.getEntity('state', cacheKey(resourceId))
    if (e) { _mem[resourceId] = JSON.parse(e.stateJson); return _mem[resourceId] }
  } catch {}
  return null
}

async function cacheSet(resourceId, state) {
  _mem[resourceId] = state
  try {
    await getTableClient()?.upsertEntity(
      { partitionKey: 'state', rowKey: cacheKey(resourceId), stateJson: JSON.stringify(state) },
      'Replace'
    )
  } catch (cacheWriteError) {
    console.warn('[cacheSet] non-fatal Table write error:', cacheWriteError.message)
  }
}

// Proxy so legacy code using liveStateCache[id] = x still works
const liveStateCache = new Proxy(_mem, {
  set(t, k, v) { t[k] = v; cacheSet(k, v).catch(() => {}); return true },
  get(t, k)    { return t[k] },
})

//  Message parser 
function parseMessage(msg) {
  console.log('[parseMessage] starts')
  try {
    const raw    = JSON.parse(Buffer.from(msg.messageText, 'base64').toString('utf-8'))
    const event  = Array.isArray(raw) ? raw[0] : raw
    const claims = event.data?.claims || {}

    // Normalize child resource URIs to parent (blobServices/default -> storageAccounts/foo)
    let resourceId = event.data?.resourceUri || event.subject || ''
    const parts    = resourceId.split('/')
    if (parts.length > 9) resourceId = parts.slice(0, 9).join('/')

    // Skip ResourceActionSuccess — system-generated events with no human operator or operationName
    if ((event.eventType || '').includes('ResourceActionSuccess')) {
      console.log('[parseMessage] ends — skipping ResourceActionSuccess event')
      return null
    }
    const uriParts = resourceId.split('/')

    // Extract best available caller identity from all known claim paths
    const givenName = claims['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'] || ''
    const surname   = claims['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname']   || ''
    const caller    = claims.name
      || claims['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name']
      || claims.unique_name
      || claims['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn']
      || (givenName && surname ? `${givenName} ${surname}` : '')
      || event.data?.caller
      || 'System'  // fallback when no identity claims present (e.g. automated/service operations)

    const result = {
      eventId:        event.id,
      eventType:      event.eventType,
      eventTime:      event.eventTime || new Date().toISOString(),
      resourceId,
      subscriptionId: uriParts[2] || event.data?.subscriptionId || '',
      resourceGroup:  uriParts.length >= 5 ? uriParts[4] : (event.data?.resourceGroupName || ''),
      operationName:  event.data?.operationName || event.eventType,
      status:         event.data?.status || 'Succeeded',
      caller,
    }
    console.log('[parseMessage] ends — resourceId:', result.resourceId)
    return result
  } catch {
    console.log('[parseMessage] ends — parse failed, returning null')
    return null
  }
}
//  parseMessage END 


//  Deduplication: same resource+operation within 0.1s = same event 
const _dedup = new Map()
function isDuplicate(event) {
  const bucket = Math.floor(new Date(event.eventTime).getTime() / 100)
  const key    = `${event.resourceId}:${event.operationName}:${bucket}`
  if (_dedup.has(key)) return true
  _dedup.set(key, Date.now())
  const cutoff = Date.now() - 60000
  for (const [k, ts] of _dedup) if (ts < cutoff) _dedup.delete(k)
  return false
}
//  isDuplicate END 

//  Enrich event with diff and resolved identity 
async function enrichWithDiff(event) {
  if (!event.resourceId || !event.subscriptionId || !event.resourceGroup) return event

  const [liveRaw, resolvedCaller] = await Promise.all([
    getResourceConfig(event.subscriptionId, event.resourceGroup, event.resourceId),
    resolveIdentity(event.caller),
  ])

  const current  = strip(liveRaw)
  const previous = await cacheGet(event.resourceId)
    || await (async () => {
      try {
        const b = await getBlobServiceModule().getBaseline(event.subscriptionId, event.resourceId)
        return b?.resourceState ? strip(b.resourceState) : null
      } catch { return null }
    })()

  const changes = previous ? diffObjects(previous, current) : []

  await cacheSet(event.resourceId, current)

  return {
    ...event,
    caller:      resolvedCaller || event.caller,
    liveState:   current,
    changes,
    changeCount: changes.length,
    hasPrevious: !!previous,
  }
}

//  Poller 
function startQueuePoller() {
  console.log('[startQueuePoller] starts')
  const interval = parseInt(process.env.QUEUE_POLL_INTERVAL_MS || '5000', 10)
  const client   = getQueueClient()

  setInterval(async () => {
    try {
      const { receivedMessageItems } = await client.receiveMessages({ numberOfMessages: 32, visibilityTimeout: 300 })
      for (const msg of receivedMessageItems) {
        const event = parseMessage(msg)
        if (!event) { await client.deleteMessage(msg.messageId, msg.popReceipt); continue }
        if (isDuplicate(event)) { await client.deleteMessage(msg.messageId, msg.popReceipt); continue }

        try {
          const enriched = await enrichWithDiff(event)
          await client.deleteMessage(msg.messageId, msg.popReceipt)

          // Permanently record to all-changes blob + changesIndex Table
          try {
            await getBlobServiceModule().saveChangeRecord({
              subscriptionId: enriched.subscriptionId,
              resourceId:     enriched.resourceId,
              resourceGroup:  enriched.resourceGroup,
              eventType:      enriched.eventType,
              operationName:  enriched.operationName,
              changeType:     (enriched.eventType || '').includes('Delete') ? 'deleted' : 'modified',
              caller:         enriched.caller,
              detectedAt:     enriched.eventTime,
              changeCount:    enriched.changeCount || 0,
              source:         'queue-poller',
            })
          } catch { /* non-fatal */ }

          // Write to driftIndex if changes detected against baseline
          if (enriched.changes?.length > 0 && enriched.hasPrevious) {
            try {
              const severity = classifySeverity(enriched.changes)
              await getBlobServiceModule().saveDriftRecord({
                subscriptionId:  enriched.subscriptionId,
                resourceId:      enriched.resourceId,
                resourceGroup:   enriched.resourceGroup,
                differences:     enriched.changes,
                severity,
                changeCount:     enriched.changes.length,
                caller:          enriched.caller || 'System',
                detectedAt:      enriched.eventTime || new Date().toISOString(),
                liveState:       enriched.liveState,
                baselineState:   null,
              })
            } catch (driftErr) {
              console.log('[queuePoller] driftIndex write failed (non-fatal):', driftErr.message)
            }
          }

          if (global.io) {
            const rgRoom = enriched.resourceGroup ? `${enriched.subscriptionId}:${enriched.resourceGroup}`.toLowerCase() : null
            const resName = enriched.resourceId?.split('/').pop()?.toLowerCase()
            const rooms = [
              enriched.subscriptionId?.toLowerCase(),
              rgRoom,
              rgRoom && resName ? `${rgRoom}:${resName}` : null,
            ].filter(Boolean)
            rooms.forEach(room => global.io.to(room).emit('resourceChange', enriched))
            if (global._markEmitted) global._markEmitted(enriched)
          }
        } catch { await client.deleteMessage(msg.messageId, msg.popReceipt).catch(() => {}) }
      }
    } catch (pollError) {
      console.error('[startQueuePoller] poll cycle error:', pollError.message)
    }
  }, interval)

  console.log(`[ADIP] Queue poller started — interval ${interval}ms`)
}
//  startQueuePoller END 

module.exports = { startQueuePoller, liveStateCache, cacheSet }