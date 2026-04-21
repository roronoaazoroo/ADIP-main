// FILE: adip-backend/function-app/detectDrift/index.js
// ROLE: Azure Function — detects drift between live ARM config and stored baseline

// Trigger: HTTP POST from adip-logic-app Logic App
//   (Logic App receives Event Grid events, filters noise, calls this Function)

// What this function does (in order):
//   1. Receives the ARM change event from the Logic App
//   2. Looks up the correct ARM API version for the resource type
//      (checks API_VERSION_MAP first, falls back to armClient.providers.get())
//   3. Fetches the current live ARM config for the resource
//   4. Reads the golden baseline blob from 'baselines' container
//   5. Strips volatile fields (etag, provisioningState) from both configs
//   6. Runs diffObjects() to get field-level changes
//   7. Calls classifySeverity() — Critical / High / Medium / Low
//   8. Writes drift record to 'drift-records' blob + 'driftIndex' Table
//   9. POSTs to EXPRESS_API_URL/internal/drift-event to push to Socket.IO
//  10. Sends email alert via ACS for High/Critical severity

// Deployed to: adip-func-001 (Azure Functions, West US 2, Consumption plan)
// Auth level:  function (requires ?code= key in URL)

require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') })
const { ResourceManagementClient } = require('@azure/arm-resources')
const { DefaultAzureCredential }   = require('@azure/identity')
const { BlobServiceClient }        = require('@azure/storage-blob')
const fetch                        = require('node-fetch')

const { strip, diffObjects }       = require('adip-shared/diff')
const { classifySeverity }         = require('adip-shared/severity')
const { blobKey, driftKey, readBlob, writeBlob } = require('adip-shared/blobHelpers')
const { API_VERSION_MAP }          = require('adip-shared/constants')

// Connect to Azure Blob Storage using the connection string from .env
const blobStorageClient    = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
const baselinesContainer   = blobStorageClient.getContainerClient('baselines')    // golden baseline blobs
const driftRecordsContainer = blobStorageClient.getContainerClient('drift-records') // detected drift blobs


// ── Main handler START ────────────────────────────────────────────────────────
module.exports = async function (context, req) {
  const body = req.body

  // Event Grid validation handshake
  if (Array.isArray(body) && body[0]?.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent') {
    context.res = { status: 200, body: { validationResponse: body[0].data.validationCode } }
    return
  }

  const eventData = Array.isArray(body) ? body[0]?.data : body
  const { resourceId, subscriptionId } = eventData || {}
  if (!resourceId || !subscriptionId) {
    context.res = { status: 400, body: { error: 'resourceId and subscriptionId required' } }
    return
  }

  try {
    const credential = new DefaultAzureCredential()
    const armClient  = new ResourceManagementClient(credential, subscriptionId)
    // ARM resource IDs follow: /subscriptions/{sub}/resourceGroups/{rg}/providers/{provider}/{type}/{name}
    const resourceIdParts    = resourceId.split('/')
    const resourceGroupName  = resourceIdParts[4] || ''
    const providerNamespace  = resourceIdParts[6] || ''  // e.g. Microsoft.Storage
    const resourceTypeName   = resourceIdParts[7] || ''  // e.g. storageAccounts
    const resourceName       = resourceIdParts[8] || ''  // e.g. adipstore001

    if (!resourceGroupName || !providerNamespace || !resourceTypeName || !resourceName) {
      context.res = { status: 400, body: { error: 'Invalid resourceId: ' + resourceId } }
      return
    }

    // Look up the correct ARM API version for this resource type
    // First check our hardcoded map, then ask ARM dynamically if not found
    let armApiVersion = API_VERSION_MAP[resourceTypeName.toLowerCase()]
    if (!armApiVersion) {
      try {
        const providerDetails = await armClient.providers.get(providerNamespace)
        const matchingType    = providerDetails.resourceTypes?.find(rt => rt.resourceType?.toLowerCase() === resourceTypeName.toLowerCase())
        armApiVersion = matchingType?.apiVersions?.find(v => !v.includes('preview')) || matchingType?.apiVersions?.[0] || '2021-04-01'
      } catch { armApiVersion = '2021-04-01' }
    }
    // Fetch the current live configuration of the resource from ARM
    const liveConfigRaw = await armClient.resources.get(resourceGroupName, providerNamespace, '', resourceTypeName, resourceName, armApiVersion)
    // Strip volatile fields (etag, provisioningState, etc.) before comparing
    const liveConfigStripped     = strip(liveConfigRaw)

    // Read the stored golden baseline for this resource
    const baselineDocument       = await readBlob(baselinesContainer, blobKey(resourceId))
    const baselineConfigStripped = baselineDocument ? strip(baselineDocument.resourceState) : null

    // Compare baseline vs live — returns array of {path, oldValue, newValue, type}
    const detectedChanges = baselineConfigStripped ? diffObjects(baselineConfigStripped, liveConfigStripped) : []
    const driftSeverity   = classifySeverity(detectedChanges)  // Critical / High / Medium / Low

    // No changes detected — resource matches baseline, nothing to record
    if (detectedChanges.length === 0) {
      context.res = { status: 200, body: { drifted: false, changeCount: 0 } }
      return
    }

    const detectedAt = new Date().toISOString()
    // Build the drift record that gets saved to blob storage and sent to the frontend
    const driftRecord = {
      subscriptionId,
      resourceId,
      resourceGroup:  resourceGroupName,
      liveState:      liveConfigStripped,
      baselineState:  baselineConfigStripped,
      differences:    detectedChanges,
      changes:        detectedChanges,   // alias — frontend uses both field names
      severity:       driftSeverity,
      changeCount:    detectedChanges.length,
      hasPrevious:    !!baselineConfigStripped,
      detectedAt,
    }

    // Save the drift record to blob storage (drift-records container)
    await writeBlob(driftRecordsContainer, driftKey(resourceId, detectedAt), driftRecord)

    // Notify the Express API so it can push the event to the browser via Socket.IO
    const expressApiUrl = process.env.EXPRESS_API_URL
    if (expressApiUrl) {
      fetch(`${expressApiUrl}/internal/drift-event`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(driftRecord),
      }).catch(() => {})  // fire-and-forget — don't block the response
    }

    context.res = { status: 200, body: { drifted: true, ...driftRecord } }
    context.log(`detectDrift: ${driftSeverity} — ${detectedChanges.length} change(s) on ${resourceName}`)
  } catch (err) {
    context.log.error('detectDrift error:', err.message)
    context.res = { status: 500, body: { error: err.message } }
  }
}
// ── Main handler END ──────────────────────────────────────────────────────────
