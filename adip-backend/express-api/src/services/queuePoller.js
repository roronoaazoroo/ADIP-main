const { QueueServiceClient } = require('@azure/storage-queue')

let queueClient = null

function getQueueClient() {
  if (!queueClient) {
    const svc = QueueServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
    queueClient = svc.getQueueClient(process.env.STORAGE_QUEUE_NAME || 'resource-changes')
  }
  return queueClient
}

// Parse Event Grid message from queue (base64 encoded)
function parseMessage(msg) {
  try {
    const decoded = Buffer.from(msg.messageText, 'base64').toString('utf-8')
    const parsed  = JSON.parse(decoded)
    // Event Grid wraps in array
    const event   = Array.isArray(parsed) ? parsed[0] : parsed
    return {
      eventId:        event.id,
      eventType:      event.eventType,
      subject:        event.subject,
      eventTime:      event.eventTime,
      resourceId:     event.data?.resourceUri || event.subject,
      subscriptionId: event.data?.subscriptionId || '',
      resourceGroup:  event.data?.resourceUri?.split('/')[4] || '',
      operationName:  event.data?.operationName || event.eventType,
      status:         event.data?.status || 'Succeeded',
      caller:         event.data?.claims?.name || event.data?.caller || 'unknown',
    }
  } catch {
    return null
  }
}

// Deduplication cache: key → timestamp of last broadcast
// Prevents duplicate events for the same resource within DEDUP_WINDOW_MS
const dedupCache = {}
const DEDUP_WINDOW_MS = 5000

function isDuplicate(event) {
  const key  = `${event.resourceId}:${event.operationName}`
  const now  = Date.now()
  const last = dedupCache[key]
  if (last && now - last < DEDUP_WINDOW_MS) return true
  dedupCache[key] = now
  // Prune stale entries every 100 events to prevent memory growth
  if (Object.keys(dedupCache).length > 100) {
    for (const k of Object.keys(dedupCache)) {
      if (now - dedupCache[k] > DEDUP_WINDOW_MS * 2) delete dedupCache[k]
    }
  }
  return false
}

// Start polling the queue and emit change events via Socket.IO
function startQueuePoller() {
  const interval = parseInt(process.env.QUEUE_POLL_INTERVAL_MS || '5000', 10)
  const client   = getQueueClient()

  setInterval(async () => {
    try {
      const response = await client.receiveMessages({ numberOfMessages: 32, visibilityTimeout: 30 })
      for (const msg of response.receivedMessageItems) {
        const event = parseMessage(msg)
        if (event && !isDuplicate(event)) {
          if (global.io) {
            const rooms = [event.subscriptionId, `${event.subscriptionId}:${event.resourceGroup}`].filter(Boolean)
            rooms.forEach(room => global.io.to(room).emit('resourceChange', event))
          }
          await client.deleteMessage(msg.messageId, msg.popReceipt)
        } else if (event) {
          // Duplicate — still delete from queue so it doesn't reappear
          await client.deleteMessage(msg.messageId, msg.popReceipt)
        }
      }
    } catch (err) {}
  }, interval)

  console.log(`Queue poller started — polling every ${interval}ms`)
}

module.exports = { startQueuePoller }
