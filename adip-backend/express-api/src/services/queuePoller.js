'use strict'
const { QueueServiceClient } = require('@azure/storage-queue')
const { TableClient }        = require('@azure/data-tables')
const { strip, diffObjects } = require('../shared/diff')
const { resolveIdentity }    = require('../shared/identity')
const { getResourceConfig }  = require('./azureResourceService')

// ── Queue client ──────────────────────────────────────────────────────────────
let _queueClient = null
function getQueueClient() {
  if (!_queueClient) {
    const svc = QueueServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
    _queueClient = svc.getQueueClient(process.env.STORAGE_QUEUE_NAME || 'resource-changes')
  }
  return _queueClient
}
// ── getQueueClient END ───────────────────────────────────────────────────────


// ── Persistent state cache (Azure Table Storage + in-memory L1) ───────────────
const _mem = {}
let _tableClient = null
function getTableClient() {
  if (!_tableClient)
    try { _tableClient = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'liveStateCache') } catch {}
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
// ── resolveIdentity END ──────────────────────────────────────────────────────

async function cacheSet(resourceId, state) {
  _mem[resourceId] = state
  try {
    await getTableClient()?.upsertEntity(
      { partitionKey: 'state', rowKey: cacheKey(resourceId), stateJson: JSON.stringify(state) },
      'Replace'
    )
  } catch { /* non-fatal */ }
}

// Proxy so legacy code using liveStateCache[id] = x still works
const liveStateCache = new Proxy(_mem, {
  set(t, k, v) { t[k] = v; cacheSet(k, v).catch(() => {}); return true },
  get(t, k)    { return t[k] },
})

// ── Message parser ────────────────────────────────────────────────────────────
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
      || ''

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
// ── parseMessage END ─────────────────────────────────────────────────────────


// ── Deduplication: same resource+operation within 10s = same event ────────────
const _dedup = new Map()
function isDuplicate(event) {
  const bucket = Math.floor(new Date(event.eventTime).getTime() / 10000)
  const key    = `${event.resourceId}:${event.operationName}:${bucket}`
  if (_dedup.has(key)) return true
  _dedup.set(key, Date.now())
  const cutoff = Date.now() - 60000
  for (const [k, ts] of _dedup) if (ts < cutoff) _dedup.delete(k)
  return false
}
// ── isDuplicate END ──────────────────────────────────────────────────────────

// ── Enrich event with diff and resolved identity ──────────────────────────────
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
        const { getBaseline } = require('./blobService')
        const b = await getBaseline(event.subscriptionId, event.resourceId)
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

// ── Poller ────────────────────────────────────────────────────────────────────
function startQueuePoller() {
  console.log('[startQueuePoller] starts')
  const interval = parseInt(process.env.QUEUE_POLL_INTERVAL_MS || '5000', 10)
  const client   = getQueueClient()

  setInterval(async () => {
    try {
      const { receivedMessageItems } = await client.receiveMessages({ numberOfMessages: 32, visibilityTimeout: 30 })
      for (const msg of receivedMessageItems) {
        const event = parseMessage(msg)
        if (!event) { await client.deleteMessage(msg.messageId, msg.popReceipt); continue }
        if (isDuplicate(event)) { await client.deleteMessage(msg.messageId, msg.popReceipt); continue }

        enrichWithDiff(event)
          .then(async enriched => {
            await client.deleteMessage(msg.messageId, msg.popReceipt)
            if (!global.io) return
            const rgRoom = enriched.resourceGroup ? `${enriched.subscriptionId}:${enriched.resourceGroup}`.toLowerCase() : null
            const resName = enriched.resourceId?.split('/').pop()?.toLowerCase()
            const rooms = [
              enriched.subscriptionId?.toLowerCase(),
              rgRoom,
              rgRoom && resName ? `${rgRoom}:${resName}` : null,
            ].filter(Boolean)
            rooms.forEach(room => global.io.to(room).emit('resourceChange', enriched))
            // Pre-register in cross-path dedup so /internal/drift-event skips this event
            if (global._markEmitted) global._markEmitted(enriched)
          })
          .catch(() => {})
      }
    } catch {}
  }, interval)

  console.log(`[ADIP] Queue poller started — interval ${interval}ms`)
}
// ── startQueuePoller END ─────────────────────────────────────────────────────

module.exports = { startQueuePoller, liveStateCache, cacheSet }