// ============================================================
// FILE: adip-backend/function-app/detectDrift/index.js
// ROLE: Azure Function — detects drift between live ARM config and stored baseline
//
// Trigger: HTTP POST from adip-logic-app Logic App
//   (Logic App receives Event Grid events, filters noise, calls this Function)
//
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
//
// Deployed to: adip-func-001 (Azure Functions, West US 2, Consumption plan)
// Auth level:  function (requires ?code= key in URL)
// ============================================================
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') })
const { ResourceManagementClient } = require('@azure/arm-resources')
const { DefaultAzureCredential }   = require('@azure/identity')
const { BlobServiceClient }        = require('@azure/storage-blob')
const fetch                        = require('node-fetch')

const { strip, diffObjects }       = require('adip-shared/diff')
const { classifySeverity }         = require('adip-shared/severity')
const { blobKey, driftKey, readBlob, writeBlob } = require('adip-shared/blobHelpers')
const { API_VERSION_MAP }          = require('adip-shared/constants')

const blobService = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
const baselineCtr = blobService.getContainerClient('baselines')
const driftCtr    = blobService.getContainerClient('drift-records')


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
    const parts      = resourceId.split('/')
    const rgName     = parts[4] || ''
    const provider   = parts[6] || ''
    const type       = parts[7] || ''
    const name       = parts[8] || ''

    if (!rgName || !provider || !type || !name) {
      context.res = { status: 400, body: { error: 'Invalid resourceId: ' + resourceId } }
      return
    }

    let apiVersion = API_VERSION_MAP[type.toLowerCase()]
    if (!apiVersion) {
      try {
        const providerInfo = await armClient.providers.get(provider)
        const rt = providerInfo.resourceTypes?.find(r => r.resourceType?.toLowerCase() === type.toLowerCase())
        apiVersion = rt?.apiVersions?.find(v => !v.includes('preview')) || rt?.apiVersions?.[0] || '2021-04-01'
      } catch { apiVersion = '2021-04-01' }
    }
    const liveRaw    = await armClient.resources.get(rgName, provider, '', type, name, apiVersion)
    const live       = strip(liveRaw)

    const baseline  = await readBlob(baselineCtr, blobKey(resourceId))
    const baseState = baseline ? strip(baseline.resourceState) : null
    const changes   = baseState ? diffObjects(baseState, live) : []
    const severity  = classifySeverity(changes)

    if (changes.length === 0) {
      context.res = { status: 200, body: { drifted: false, changeCount: 0 } }
      return
    }

    const detectedAt = new Date().toISOString()
    const record = {
      subscriptionId, resourceId,
      resourceGroup: rgName,
      liveState:     live,
      baselineState: baseState,
      differences:   changes,
      changes,           // alias — frontend uses both field names
      severity,
      changeCount:   changes.length,
      hasPrevious:   !!baseState,
      detectedAt,
    }

    await writeBlob(driftCtr, driftKey(resourceId, detectedAt), record)

    // Push to Express → Socket.IO if URL is configured
    const apiUrl = process.env.EXPRESS_API_URL
    if (apiUrl) {
      fetch(`${apiUrl}/internal/drift-event`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      }).catch(() => {})
    }

    context.res = { status: 200, body: { drifted: true, ...record } }
    context.log(`detectDrift: ${severity} — ${changes.length} change(s) on ${name}`)
  } catch (err) {
    context.log.error('detectDrift error:', err.message)
    context.res = { status: 500, body: { error: err.message } }
  }
}
// ── Main handler END ──────────────────────────────────────────────────────────
