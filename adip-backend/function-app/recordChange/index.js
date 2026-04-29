'use strict'
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') })
const { BlobServiceClient } = require('@azure/storage-blob')
const { TableClient }       = require('@azure/data-tables')

// Connect to Azure Blob Storage — 'all-changes' container stores one blob per ARM event
const blobStorageClient   = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
const allChangesContainer = blobStorageClient.getContainerClient('all-changes')

// Returns a Table Storage client for the changesIndex table (used for fast queries by DashboardHome)
// Returns a Table Storage client for changesIndex — no logging (pure factory, called in a loop)
function getChangesIndexTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'changesIndex')
}

// ── Main handler START ────────────────────────────────────────────────────────
// Called by Event Grid WebHook for every ARM ResourceWriteSuccess / ResourceDeleteSuccess
// Writes directly to all-changes blob + changesIndex Table — no Express dependency
module.exports = async function (context, req) {
  console.log('[recordChange mainHandler] starts')
  const body = req.body

  // Event Grid validation handshake
  if (Array.isArray(body) && body[0]?.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent') {
    console.log('[recordChange mainHandler] ends — Event Grid validation handshake response sent')
    context.res = { status: 200, body: { validationResponse: body[0].data.validationCode } }
    return
  }

  const events = Array.isArray(body) ? body : [body]
  console.log('[recordChange mainHandler] processing — total events received:', events.length)
  let recorded = 0

  for (const event of events) {
    try {
      const eventPayload = event.data || {}

      // Skip noise: failed operations, read/list calls, and ARM deployment events
      const operationName   = (eventPayload.operationName || '').toLowerCase()
      const operationStatus = (eventPayload.status || '').toLowerCase()

      if (operationStatus === 'failed') {
        console.log('[recordChange mainHandler] skipping event — status is failed, operation:', operationName)
        continue
      }
      if (operationName.includes('read') || operationName.includes('list')) {
        console.log('[recordChange mainHandler] skipping event — read/list operation:', operationName)
        continue
      }
      if ((eventPayload.resourceUri || '').toLowerCase().includes('/deployments/')) {
        console.log('[recordChange mainHandler] skipping event — deployment resource URI:', eventPayload.resourceUri)
        continue
      }
      // Skip ResourceActionSuccess — system-generated status events with no human operator
      if ((event.eventType || '').includes('ResourceActionSuccess')) {
        console.log('[recordChange mainHandler] skipping event — ResourceActionSuccess has no human operator')
        continue
      }

      // ── Resource ID normalisation START ──────────────────────────────────
      // Normalise resource ID: strip child resource paths (> 9 parts) to get the parent resource
      // e.g. /subscriptions/.../storageAccounts/foo/blobServices/default → /subscriptions/.../storageAccounts/foo
      console.log('[recordChange resourceIdNormalisation] starts — raw resourceUri:', eventPayload.resourceUri)
      let resourceId = eventPayload.resourceUri || event.subject || ''
      const resourceIdParts = resourceId.split('/')
      if (resourceIdParts.length > 9) resourceId = resourceIdParts.slice(0, 9).join('/')
      const normalizedParts = resourceId.split('/')
      const subscriptionId  = normalizedParts[2] || eventPayload.subscriptionId || ''
      const resourceGroup   = normalizedParts.length >= 5 ? normalizedParts[4] : (eventPayload.resourceGroupName || '')
      console.log('[recordChange resourceIdNormalisation] ends — resourceId:', resourceId, 'subscriptionId:', subscriptionId, 'resourceGroup:', resourceGroup)
      // ── Resource ID normalisation END ────────────────────────────────────

      if (!subscriptionId) {
        console.log('[recordChange mainHandler] skipping event — no subscriptionId extractable')
        continue
      }

      // ── Caller identity extraction START ──────────────────────────────────
      // Extract the human-readable caller identity from Azure AD claims
      // ARM events include a 'claims' object with various identity fields — try them in priority order
      console.log('[recordChange callerExtraction] starts')
      const identityClaims  = eventPayload.claims || {}
      const callerFirstName = identityClaims['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname'] || ''
      const callerLastName  = identityClaims['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname']   || ''
      const callerIdentity  = identityClaims.name || identityClaims.unique_name ||
                              (callerFirstName && callerLastName ? `${callerFirstName} ${callerLastName}` : '') ||
                              eventPayload.caller || 'System'
      console.log('[recordChange callerExtraction] ends — caller:', callerIdentity)
      // ── Caller identity extraction END ────────────────────────────────────

      const detectedAt = event.eventTime || new Date().toISOString()
      // Determine if this was a delete or a write/update
      const changeType = (event.eventType || '').includes('Delete') ? 'deleted' : 'modified'

      // The change record that gets saved to blob storage and indexed in Table Storage
      const changeRecord = {
        subscriptionId,
        resourceId,
        resourceGroup,
        eventType:     event.eventType || '',
        operationName: eventPayload.operationName || '',
        changeType,
        caller:        callerIdentity,
        detectedAt,
        source:        'event-grid-direct',  // distinguishes from queue-poller path
      }

      // ── Blob write START ──────────────────────────────────────────────────
      // Generate a unique blob filename: timestamp + base64url(resourceId)
      // base64url is used because resourceId contains '/' which is a path separator in blob storage
      console.log('[recordChange blobWrite] starts — changeType:', changeType, 'resource:', resourceId)
      const blobFileName = `${detectedAt.replace(/[:.]/g, '-')}_${Buffer.from(resourceId).toString('base64url').slice(0, 80)}.json`
      const blobContent  = JSON.stringify({ ...changeRecord, _blobKey: blobFileName })
      await allChangesContainer.getBlockBlobClient(blobFileName)
        .upload(blobContent, Buffer.byteLength(blobContent), { blobHTTPHeaders: { blobContentType: 'application/json' } })
      console.log('[recordChange blobWrite] ends — blob saved:', blobFileName)
      // ── Blob write END ────────────────────────────────────────────────────

      // ── changesIndex Table write START ────────────────────────────────────
      // Write a lightweight index row to Table Storage so DashboardHome can query changes
      // without scanning every blob (Table query is O(matches), blob scan is O(total))
      console.log('[recordChange changesIndexWrite] starts — blobFileName:', blobFileName)
      const tableRowKey = Buffer.from(blobFileName).toString('base64url').slice(0, 512)
      await getChangesIndexTable().upsertEntity({
        partitionKey:  subscriptionId,
        rowKey:        tableRowKey,
        blobKey:       blobFileName,
        resourceId,
        resourceGroup,
        eventType:     changeRecord.eventType,
        changeType,
        caller:        callerIdentity,
        detectedAt,
        changeCount:   0,
      }, 'Replace')
      console.log('[recordChange changesIndexWrite] ends — changesIndex entity upserted')
      // ── changesIndex Table write END ──────────────────────────────────────

      recorded++
    } catch (eventProcessingError) {
      console.log('[recordChange mainHandler] caught error processing event — skipping:', eventProcessingError.message)
      context.log.warn('[recordChange] skip event:', eventProcessingError.message)
    }
  }

  context.res = { status: 200, body: { recorded } }
  context.log(`[recordChange] recorded ${recorded} of ${events.length} events`)
  console.log('[recordChange mainHandler] ends — recorded:', recorded, 'of', events.length, 'events')
}
// ── Main handler END ──────────────────────────────────────────────────────────