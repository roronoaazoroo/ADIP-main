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




// ── Main handler START ───────────────────────────────────────────────────────
module.exports = async function (context, req) {
  const body = req.body

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

    const apiVersion = API_VERSION_MAP[type.toLowerCase()] || '2021-04-01'
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
      severity,
      changeCount:   changes.length,
      detectedAt,
    }

    await writeBlob(driftCtr, driftKey(resourceId, detectedAt), record)

    const apiUrl = process.env.EXPRESS_API_URL
    if (apiUrl) {
      fetch(`${apiUrl}/internal/drift-event`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      }).catch(() => {})
    }

    context.res = { status: 200, body: { drifted: true, ...record } }
  } catch (err) {
    context.log.error('detectDrift error:', err.message)
    context.res = { status: 500, body: { error: err.message } }
  }
}
// ── Main handler END ─────────────────────────────────────────────────────────
