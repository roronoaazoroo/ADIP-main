require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') })
const { BlobServiceClient } = require('@azure/storage-blob')
const { TableClient }       = require('@azure/data-tables')

const blobSvc   = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
const changesCtr = blobSvc.getContainerClient('all-changes')

function getChangesIndex() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'changesIndex')
}

// ── Main handler START ────────────────────────────────────────────────────────
// Called by Event Grid WebHook for every ARM ResourceWriteSuccess / ResourceDeleteSuccess
// Writes directly to all-changes blob + changesIndex Table — no Express dependency
module.exports = async function (context, req) {
  const body = req.body

  // Event Grid validation handshake
  if (Array.isArray(body) && body[0]?.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent') {
    context.res = { status: 200, body: { validationResponse: body[0].data.validationCode } }
    return
  }

  const events = Array.isArray(body) ? body : [body]
  let recorded = 0

  for (const event of events) {
    try {
      const data = event.data || {}

      // Skip failed, read, list, deployment operations
      const op     = (data.operationName || '').toLowerCase()
      const status = (data.status || '').toLowerCase()
      if (status === 'failed') continue
      if (op.includes('read') || op.includes('list')) continue
      if ((data.resourceUri || '').toLowerCase().includes('/deployments/')) continue

      // Normalise resource ID to parent (strip child paths > 9 parts)
      let resourceId = data.resourceUri || event.subject || ''
      const parts = resourceId.split('/')
      if (parts.length > 9) resourceId = parts.slice(0, 9).join('/')

      const uriParts       = resourceId.split('/')
      const subscriptionId = uriParts[2] || data.subscriptionId || ''
      const resourceGroup  = uriParts.length >= 5 ? uriParts[4] : (data.resourceGroupName || '')

      if (!subscriptionId) continue

      // Extract caller from claims
      const claims    = data.claims || {}
      const givenName = claims['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'] || ''
      const surname   = claims['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname']   || ''
      const caller    = claims.name || claims.unique_name ||
                        (givenName && surname ? `${givenName} ${surname}` : '') ||
                        data.caller || 'System'

      const detectedAt = event.eventTime || new Date().toISOString()
      const changeType = (event.eventType || '').includes('Delete') ? 'deleted' : 'modified'

      const record = {
        subscriptionId,
        resourceId,
        resourceGroup,
        eventType:     event.eventType || '',
        operationName: data.operationName || '',
        changeType,
        caller,
        detectedAt,
        source:        'event-grid-direct',
      }

      // Write blob
      const blobKey = `${detectedAt.replace(/[:.]/g, '-')}_${Buffer.from(resourceId).toString('base64url').slice(0, 80)}.json`
      const body    = JSON.stringify({ ...record, _blobKey: blobKey })
      await changesCtr.getBlockBlobClient(blobKey)
        .upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: 'application/json' } })

      // Write Table index
      const rk = Buffer.from(blobKey).toString('base64url').slice(0, 512)
      await getChangesIndex().upsertEntity({
        partitionKey:  subscriptionId,
        rowKey:        rk,
        blobKey,
        resourceId,
        resourceGroup,
        eventType:     record.eventType,
        changeType,
        caller,
        detectedAt,
        changeCount:   0,
      }, 'Replace')

      recorded++
    } catch (err) {
      context.log.warn('[recordChange] skip event:', err.message)
    }
  }

  context.res = { status: 200, body: { recorded } }
  context.log(`[recordChange] recorded ${recorded} of ${events.length} events`)
}
// ── Main handler END ──────────────────────────────────────────────────────────
