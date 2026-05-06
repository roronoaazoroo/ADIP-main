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

'use strict'
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') })
const { ResourceManagementClient } = require('@azure/arm-resources')
const { DefaultAzureCredential }   = require('@azure/identity')
const { BlobServiceClient }        = require('@azure/storage-blob')
const fetch                        = require('node-fetch')

const { strip, diffObjects }       = require('../shared/diff')
const { classifySeverity }         = require('../shared/severity')
const { blobKey, driftKey, readBlob, writeBlob } = require('../shared/blobHelpers')
const { API_VERSION_MAP }          = require('../shared/constants')

// Connect to Azure Blob Storage using the connection string from .env
const blobStorageClient     = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
const baselinesContainer    = blobStorageClient.getContainerClient('baselines')      // golden baseline blobs
const driftRecordsContainer = blobStorageClient.getContainerClient('drift-records')  // detected drift blobs


//  Main handler START 
module.exports = async function (context, req) {
  console.log('[detectDrift mainHandler] starts')
  const body = req.body

  // Event Grid validation handshake
  if (Array.isArray(body) && body[0]?.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent') {
    console.log('[detectDrift mainHandler] ends — Event Grid validation handshake response sent')
    context.res = { status: 200, body: { validationResponse: body[0].data.validationCode } }
    return
  }

  const eventData = Array.isArray(body) ? body[0]?.data : body
  const { resourceId, subscriptionId, caller = 'System' } = eventData || {}

  if (!resourceId || !subscriptionId) {
    console.log('[detectDrift mainHandler] ends — 400 missing resourceId or subscriptionId')
    context.res = { status: 400, body: { error: 'resourceId and subscriptionId required' } }
    return
  }

  console.log('[detectDrift mainHandler] processing — resourceId:', resourceId, 'subscriptionId:', subscriptionId)

  try {
    const credential = new DefaultAzureCredential()
    const armClient  = new ResourceManagementClient(credential, subscriptionId)

    // ARM resource IDs follow: /subscriptions/{sub}/resourceGroups/{rg}/providers/{provider}/{type}/{name}
    const resourceIdParts   = resourceId.split('/')
    const resourceGroupName = resourceIdParts[4] || ''
    const providerNamespace = resourceIdParts[6] || ''  // e.g. Microsoft.Storage
    const resourceTypeName  = resourceIdParts[7] || ''  // e.g. storageAccounts
    const resourceName      = resourceIdParts[8] || ''  // e.g. adipstore001

    console.log('[detectDrift mainHandler] parsed ARM ID — rg:', resourceGroupName, 'provider:', providerNamespace, 'type:', resourceTypeName, 'name:', resourceName)

    if (!resourceGroupName || !providerNamespace || !resourceTypeName || !resourceName) {
      console.log('[detectDrift mainHandler] ends — 400 invalid resourceId:', resourceId)
      context.res = { status: 400, body: { error: 'Invalid resourceId: ' + resourceId } }
      return
    }

    //  API version resolution START 
    // Look up the correct ARM API version for this resource type
    // First check our hardcoded map, then ask ARM dynamically if not found
    console.log('[detectDrift apiVersionResolution] starts — resourceTypeName:', resourceTypeName)
    let armApiVersion = API_VERSION_MAP[resourceTypeName.toLowerCase()]
    if (!armApiVersion) {
      console.log('[detectDrift apiVersionResolution] not found in static map — querying ARM providers')
      try {
        const providerDetails = await armClient.providers.get(providerNamespace)
        const matchingType    = providerDetails.resourceTypes?.find(
          rt => rt.resourceType?.toLowerCase() === resourceTypeName.toLowerCase()
        )
        armApiVersion = matchingType?.apiVersions?.find(v => !v.includes('preview'))
          || matchingType?.apiVersions?.[0]
          || '2021-04-01'
        console.log('[detectDrift apiVersionResolution] resolved from ARM providers:', armApiVersion)
      } catch (e) {
        armApiVersion = '2021-04-01'
        console.log('[detectDrift apiVersionResolution] ARM providers query failed — using fallback:', armApiVersion, 'error:', e.message)
      }
    } else {
      console.log('[detectDrift apiVersionResolution] found in static map:', armApiVersion)
    }
    console.log('[detectDrift apiVersionResolution] ends — armApiVersion:', armApiVersion)
    //  API version resolution END 

    //  Live config fetch START 
    // Fetch the current live configuration of the resource from ARM
    console.log('[detectDrift liveConfigFetch] starts — resource:', resourceName)
    const liveConfigRaw      = await armClient.resources.get(resourceGroupName, providerNamespace, '', resourceTypeName, resourceName, armApiVersion)
    // Strip volatile fields (etag, provisioningState, etc.) before comparing
    const liveConfigStripped = strip(liveConfigRaw)
    console.log('[detectDrift liveConfigFetch] ends — live config fetched and stripped')
    //  Live config fetch END 

    //  Baseline read START 
    // Read the stored golden baseline for this resource
    console.log('[detectDrift baselineRead] starts — blobKey:', blobKey(resourceId))
    const baselineDocument       = await readBlob(baselinesContainer, blobKey(resourceId))
    const baselineConfigStripped = baselineDocument ? strip(baselineDocument.resourceState) : null
    console.log('[detectDrift baselineRead] ends — baseline found:', !!baselineDocument)
    //  Baseline read END 

    //  Diff computation START 
    // Compare baseline vs live — returns array of {path, oldValue, newValue, type}
    console.log('[detectDrift diffComputation] starts')
    const detectedChanges = baselineConfigStripped ? diffObjects(baselineConfigStripped, liveConfigStripped) : []
    const driftSeverity   = classifySeverity(detectedChanges)  // Critical / High / Medium / Low
    console.log('[detectDrift diffComputation] ends — changes detected:', detectedChanges.length, 'severity:', driftSeverity)
    //  Diff computation END 

    // No changes detected — resource matches baseline, nothing to record
    if (detectedChanges.length === 0) {
      console.log('[detectDrift mainHandler] ends — no drift detected, resource matches baseline')
      context.res = { status: 200, body: { drifted: false, changeCount: 0 } }
      return
    }

    const detectedAt = new Date().toISOString()

    // Build the drift record that gets saved to blob storage and sent to the frontend
    const driftRecord = {
      subscriptionId,
      resourceId,
      resourceGroup: resourceGroupName,
      liveState:     liveConfigStripped,
      baselineState: baselineConfigStripped,
      differences:   detectedChanges,
      changes:       detectedChanges,  // alias — frontend uses both field names
      severity:      driftSeverity,
      changeCount:   detectedChanges.length,
      hasPrevious:   !!baselineConfigStripped,
      caller,
      detectedAt,
    }

    //  Drift record write START 
    // Save the drift record to blob storage (drift-records container)
    console.log('[detectDrift driftRecordWrite] starts — driftKey:', driftKey(resourceId, detectedAt))
    await writeBlob(driftRecordsContainer, driftKey(resourceId, detectedAt), driftRecord)
    console.log('[detectDrift driftRecordWrite] ends — drift record saved to blob storage')

    // Write index row to driftIndex Table for fast filtered queries (used by reports + drift-events endpoint)
    try {
      const { TableClient } = require('@azure/data-tables')
      const tableClient = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'driftIndex')
      const rowKey = Buffer.from(driftKey(resourceId, detectedAt)).toString('base64url').slice(0, 512)
      await tableClient.upsertEntity({
        partitionKey:  subscriptionId,
        rowKey,
        blobKey:       driftKey(resourceId, detectedAt),
        resourceId:    resourceId || '',
        resourceGroup: resourceGroupName || '',
        severity:      driftSeverity,
        caller:        caller || 'System',
        changeCount:   detectedChanges.length,
        detectedAt,
      }, 'Replace')
      console.log('[detectDrift driftIndexWrite] ends — driftIndex row written')
    } catch (indexError) {
      console.log('[detectDrift driftIndexWrite] non-fatal error:', indexError.message)
    }
    //  Drift record write END 

    //  Socket.IO notification START 
    // Notify the Express API so it can push the event to the browser via Socket.IO
    console.log('[detectDrift socketNotification] starts — expressApiUrl:', process.env.EXPRESS_API_URL)
    const expressApiUrl = process.env.EXPRESS_API_URL
    if (expressApiUrl) {
      fetch(`${expressApiUrl}/internal/drift-event`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(driftRecord),
      }).catch(err => {
        console.log('[detectDrift socketNotification] fire-and-forget POST failed:', err.message)
      })
      console.log('[detectDrift socketNotification] ends — POST to Express dispatched (fire-and-forget)')
    } else {
      console.log('[detectDrift socketNotification] ends — skipped, EXPRESS_API_URL not configured')
    }
    //  Socket.IO notification END 

    context.log(`detectDrift: ${driftSeverity} — ${detectedChanges.length} change(s) on ${resourceName}`)
    console.log('[detectDrift mainHandler] ends — drifted: true, severity:', driftSeverity, 'changes:', detectedChanges.length)
    context.res = { status: 200, body: { drifted: true, ...driftRecord } }

  } catch (err) {
    console.log('[detectDrift mainHandler] ends — caught error:', err.message)
    context.log.error('detectDrift error:', err.message)
    context.res = { status: 500, body: { error: err.message } }
  }
}
//  Main handler END 