const { QueueServiceClient } = require('@azure/storage-queue')
const { getResourceConfig }  = require('./azureResourceService')

let queueClient = null

function getQueueClient() {
  if (!queueClient) {
    const svc = QueueServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
    queueClient = svc.getQueueClient(process.env.STORAGE_QUEUE_NAME || 'resource-changes')
  }
  return queueClient
}

function parseMessage(msg) {
  try {
    const decoded     = Buffer.from(msg.messageText, 'base64').toString('utf-8')
    const parsed      = JSON.parse(decoded)
    const event       = Array.isArray(parsed) ? parsed[0] : parsed
    let resourceUri = event.data?.resourceUri || event.subject || ''
    // Normalize child resource URIs to parent (e.g. blobServices/default -> storageAccounts/foo)
    const uriParts = resourceUri.split('/')
    if (uriParts.length > 9) resourceUri = uriParts.slice(0, 9).join('/')
    const parts = resourceUri.split('/')
    const resourceGroup = parts.length >= 5 ? parts[4] : (event.data?.resourceGroupName || '')

    // Extract caller: prefer display name from claims, fall back to email/UPN
    const claims = event.data?.claims || {}
    const caller  = claims.name || claims['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name']
                 || event.data?.caller || 'Unknown user'

    return {
      eventId:        event.id,
      eventType:      event.eventType,
      subject:        event.subject,
      // Task 3: use Azure eventTime, not frontend render time
      eventTime:      event.eventTime || new Date().toISOString(),
      resourceId:     resourceUri,
      subscriptionId: parts[2] || event.data?.subscriptionId || '',
      resourceGroup,
      operationName:  event.data?.operationName || event.eventType,
      status:         event.data?.status || 'Succeeded',
      caller,
    }
  } catch { return null }
}

const VOLATILE = ['etag','changedTime','createdTime','provisioningState','lastModifiedAt','systemData','_ts','_etag','primaryEndpoints','secondaryEndpoints','primaryLocation','secondaryLocation','statusOfPrimary','statusOfSecondary','creationTime']
function strip(obj) {
  if (Array.isArray(obj)) return obj.map(strip)
  if (obj && typeof obj === 'object')
    return Object.fromEntries(Object.entries(obj).filter(([k]) => !VOLATILE.includes(k)).map(([k,v]) => [k, strip(v)]))
  return obj
}

// Hardened recursive diff engine — handles nested objects, arrays, null transitions
function safeStr(val) {
  if (val === null || val === undefined) return 'null'
  if (typeof val === 'object') return JSON.stringify(val)
  return String(val)
}

function computeDiff(prev, curr, path, results) {
  if (prev === null || prev === undefined) {
    if (curr !== null && curr !== undefined) {
      if (typeof curr === 'object' && !Array.isArray(curr)) {
        for (const k of Object.keys(curr)) computeDiff(undefined, curr[k], `${path} → ${k}`, results)
      } else {
        const field = path.split(' → ').pop()
        const isTag = path.includes('tags')
        results.push({ path, type: 'added', oldValue: null, newValue: curr,
          sentence: isTag ? `added tag '${field}' = "${curr}"` : `added "${field}" = ${safeStr(curr)}` })
      }
    }
    return
  }
  if (curr === null || curr === undefined) {
    const field = path.split(' → ').pop()
    const isTag = path.includes('tags')
    results.push({ path, type: 'removed', oldValue: prev, newValue: null,
      sentence: isTag ? `deleted tag '${field}'` : `removed "${field}" (was ${safeStr(prev)})` })
    return
  }
  if (Array.isArray(prev) && Array.isArray(curr)) {
    const stableStr = (v) => JSON.stringify(v, Object.keys(v || {}).sort())
    const normArr = (a) => JSON.stringify(a.map(i => typeof i === 'object' && i ? stableStr(i) : i).sort())
    if (normArr(prev) !== normArr(curr)) {
      const added   = curr.filter(c => !prev.some(p => JSON.stringify(p) === JSON.stringify(c)))
      const removed = prev.filter(p => !curr.some(c => JSON.stringify(c) === JSON.stringify(p)))
      const field   = path.split(' → ').pop()
      if (added.length)   results.push({ path, type: 'array-added',   oldValue: prev, newValue: curr, sentence: `added ${added.length} item(s) to "${field}"` })
      if (removed.length) results.push({ path, type: 'array-removed', oldValue: prev, newValue: curr, sentence: `removed ${removed.length} item(s) from "${field}"` })
      if (!added.length && !removed.length) results.push({ path, type: 'array-reordered', oldValue: prev, newValue: curr, sentence: `reordered items in "${field}"` })
    }
    return
  }
  if (typeof prev === 'object' && typeof curr === 'object') {
    const allKeys = new Set([...Object.keys(prev), ...Object.keys(curr)])
    for (const k of allKeys) computeDiff(prev[k], curr[k], path ? `${path} → ${k}` : k, results)
    return
  }
  if (prev !== curr) {
    const field = path.split(' → ').pop()
    const isTag = path.includes('tags')
    results.push({ path, type: 'modified', oldValue: prev, newValue: curr,
      sentence: isTag ? `changed tag '${field}' from "${prev}" to "${curr}"` : `changed "${field}" from "${safeStr(prev)}" to "${safeStr(curr)}"` })
  }
}

// Flatten _childConfig into top-level so baseline (without _childConfig) diffs cleanly
function normalize(obj) {
  if (!obj || typeof obj !== 'object') return obj
  const { _childConfig, ...rest } = obj
  if (_childConfig) {
    Object.entries(_childConfig).forEach(([k, v]) => { rest[k] = v })
  }
  return rest
}

function formatDiff(prev, curr) {
  const results = []
  computeDiff(normalize(prev), normalize(curr), '', results)
  return results.filter(r => r.path !== '')
}

// Task 1: in-memory cache of last known live state per resourceId
// Exported so the /api/cache-state endpoint can pre-seed it on Submit
const liveStateCache = {}

async function enrichWithDiff(event) {
  if (!event.resourceId || !event.subscriptionId || !event.resourceGroup) return event
  try {
    const liveRaw = await getResourceConfig(event.subscriptionId, event.resourceGroup, event.resourceId)
    const current = strip(liveRaw)

    let previous = liveStateCache[event.resourceId] || null

    // If no cached previous state, fall back to stored baseline so we always show a diff
    if (!previous) {
      try {
        const { getBaseline } = require('./blobService')
        const baseline = await getBaseline(event.subscriptionId, event.resourceId)
        if (baseline?.resourceState) previous = strip(baseline.resourceState)
      } catch (_) {}
    }

    const changes = previous ? formatDiff(previous, current) : []

    // Always update cache after fetching
    liveStateCache[event.resourceId] = current

    // Auto-save to genome on every real change event
    if (changes.length > 0) {
      try {
        const { saveGenomeSnapshot } = require('./blobService')
        const label = `auto: ${changes.length} change(s) by ${event.caller || 'system'}`
        saveGenomeSnapshot(event.subscriptionId, event.resourceId, current, label).catch(() => {})
      } catch (_) {}
    }

    return {
      ...event,
      liveState:   current,
      changes,
      changeCount: changes.length,
      hasPrevious: !!previous,
    }
  } catch {
    return event
  }
}
// Deduplication keyed on eventId
const dedupCache = new Set()
function isDuplicate(event) {
  const key = event.eventId || `${event.resourceId}:${event.eventTime}`
  if (dedupCache.has(key)) return true
  dedupCache.add(key)
  if (dedupCache.size > 500) {
    const iter = dedupCache.values()
    for (let i = 0; i < 100; i++) dedupCache.delete(iter.next().value)
  }
  return false
}

function startQueuePoller() {
  const interval = parseInt(process.env.QUEUE_POLL_INTERVAL_MS || '5000', 10)
  const client   = getQueueClient()

  setInterval(async () => {
    try {
      const response = await client.receiveMessages({ numberOfMessages: 32, visibilityTimeout: 30 })
      for (const msg of response.receivedMessageItems) {
        const event = parseMessage(msg)
        if (!event) continue
        await client.deleteMessage(msg.messageId, msg.popReceipt)
        if (isDuplicate(event)) continue

        enrichWithDiff(event).then(enriched => {
          if (global.io) {
            const rooms = [enriched.subscriptionId, `${enriched.subscriptionId}:${enriched.resourceGroup}`].filter(Boolean)
            rooms.forEach(room => global.io.to(room).emit('resourceChange', enriched))
          }
        })
      }
    } catch (_) {}
  }, interval)

  console.log(`Queue poller started — polling every ${interval}ms`)
}

module.exports = { startQueuePoller, liveStateCache }
