const router = require('express').Router()
const { ResourceManagementClient } = require('@azure/arm-resources')
const { DefaultAzureCredential } = require('@azure/identity')
const { getBaseline } = require('../services/cosmosService')
const { getResourceConfig } = require('../services/azureResourceService')
const { getApiVersion } = require('../services/azureResourceService')
const { sendDriftAlert } = require('../services/alertService')
const { diff } = require('deep-diff')

const VOLATILE = ['etag', 'changedTime', 'createdTime', 'provisioningState', 'lastModifiedAt', 'systemData', '_ts', '_etag', '_rid', '_self', 'id']

function strip(obj) {
  if (Array.isArray(obj)) return obj.map(strip)
  if (obj && typeof obj === 'object')
    return Object.fromEntries(Object.entries(obj).filter(([k]) => !VOLATILE.includes(k)).map(([k, v]) => [k, strip(v)]))
  return obj
}

router.post('/remediate', async (req, res) => {
  const { subscriptionId, resourceGroupId, resourceId } = req.body
  if (!subscriptionId || !resourceGroupId || !resourceId)
    return res.status(400).json({ error: 'subscriptionId, resourceGroupId and resourceId required' })

  try {
    const baseline = await getBaseline(subscriptionId, resourceId)
    if (!baseline?.resourceState)
      return res.status(404).json({ error: 'No golden baseline found for this resource' })

    const baselineState = strip(baseline.resourceState)
    const liveRaw       = await getResourceConfig(subscriptionId, resourceGroupId, resourceId)
    const liveState     = strip(liveRaw)
    const differences   = diff(liveState, baselineState) || []

    // Send alert email BEFORE applying the change
    await sendDriftAlert({
      resourceId,
      resourceGroup:  resourceGroupId,
      subscriptionId,
      severity:       'critical',   // remediation is always a critical action
      changeCount:    differences.length,
      detectedAt:     new Date().toISOString(),
      note:           'Remediation applied — resource reverted to golden baseline',
    })

    const credential = new DefaultAzureCredential()
    const armClient  = new ResourceManagementClient(credential, subscriptionId)
    const parts      = resourceId.split('/')
    const provider   = parts[6]
    const type       = parts[7]
    const name       = parts[8]
    const rgName     = parts[4]
    const apiVersion = await getApiVersion(subscriptionId, provider, type)

    await armClient.resources.beginCreateOrUpdateAndWait(
      rgName, provider, '', type, name, apiVersion,
      { ...baselineState, location: baseline.resourceState.location }
    )

    res.json({ remediated: true, resourceId, changeCount: differences.length,
      appliedBaseline: baselineState, previousLiveState: liveState })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
