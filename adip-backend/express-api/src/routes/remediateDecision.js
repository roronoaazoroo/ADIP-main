const router = require('express').Router()
const { getBaseline, saveBaseline } = require('../services/cosmosService')
const { getResourceConfig }         = require('../services/azureResourceService')
const { getApiVersion }             = require('../services/azureResourceService')
const { ResourceManagementClient }  = require('@azure/arm-resources')
const { DefaultAzureCredential }    = require('@azure/identity')

// GET /api/remediate-decision?action=approve|reject&token=<base64url>
// Called when user clicks Approve or Reject in the email
router.get('/remediate-decision', async (req, res) => {
  const { action, token } = req.query
  if (!token || !['approve', 'reject'].includes(action)) {
    return res.status(400).send(html('Invalid Request', 'Missing or invalid action/token.', '#dc2626'))
  }

  let payload
  try {
    payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf-8'))
  } catch {
    return res.status(400).send(html('Invalid Token', 'The approval link is malformed or expired.', '#dc2626'))
  }

  const { resourceId, resourceGroup, subscriptionId } = payload
  if (!resourceId || !subscriptionId) {
    return res.status(400).send(html('Invalid Token', 'Token is missing required fields.', '#dc2626'))
  }

  const resourceName = resourceId.split('/').pop()

  try {
    if (action === 'approve') {
      // ── Approve: revert live resource to golden baseline ──────────────────
      const baseline = await getBaseline(subscriptionId, resourceId)
      if (!baseline?.resourceState) {
        return res.send(html('No Baseline Found',
          `No golden baseline exists for <strong>${resourceName}</strong>. Cannot remediate.`, '#d97706'))
      }

      const VOLATILE = ['etag','changedTime','createdTime','provisioningState','lastModifiedAt','systemData','_ts','_etag','_rid','_self','id']
      function strip(obj) {
        if (Array.isArray(obj)) return obj.map(strip)
        if (obj && typeof obj === 'object')
          return Object.fromEntries(Object.entries(obj).filter(([k]) => !VOLATILE.includes(k)).map(([k,v]) => [k, strip(v)]))
        return obj
      }

      const baselineState = strip(baseline.resourceState)
      const credential    = new DefaultAzureCredential()
      const armClient     = new ResourceManagementClient(credential, subscriptionId)
      const parts         = resourceId.split('/')
      const rgName        = parts[4], provider = parts[6], type = parts[7], name = parts[8]
      const apiVersion    = await getApiVersion(subscriptionId, provider, type)

      // location is required by ARM — use baseline's, fall back to live resource's location
      let location = baseline.resourceState?.location
      if (!location) {
        try {
          const live = await armClient.resources.get(rgName, provider, '', type, name, apiVersion)
          location = live.location
        } catch { location = 'westus2' }
      }

      await armClient.resources.beginCreateOrUpdateAndWait(
        rgName, provider, '', type, name, apiVersion,
        { ...baselineState, location }
      )

      return res.send(html('✓ Remediation Applied',
        `<strong>${resourceName}</strong> has been successfully reverted to its golden baseline.`, '#16a34a'))

    } else {
      // ── Reject: promote current live state as new baseline ────────────────
      const liveState = await getResourceConfig(subscriptionId, resourceGroup, resourceId)
      await saveBaseline(subscriptionId, resourceGroup, resourceId, liveState)

      return res.send(html('Drift Accepted',
        `The current configuration of <strong>${resourceName}</strong> has been accepted as the new baseline.`, '#6b7280'))
    }
  } catch (err) {
    return res.status(500).send(html('Error', `Operation failed: ${err.message}`, '#dc2626'))
  }
})

// Simple HTML response page shown after clicking Approve/Reject
function html(title, message, color) {
  return `<!DOCTYPE html>
<html><head><title>ADIP — ${title}</title>
<style>body{font-family:Segoe UI,Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc}
.card{max-width:480px;padding:40px;background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.08);text-align:center}
h2{color:${color};margin:0 0 12px}p{color:#374151;font-size:14px;line-height:1.6}
a{display:inline-block;margin-top:20px;padding:10px 24px;background:#1d4ed8;color:#fff;text-decoration:none;border-radius:6px;font-size:13px}</style>
</head><body>
<div class="card">
  <h2>${title}</h2>
  <p>${message}</p>
  <a href="/">Return to ADIP Dashboard</a>
</div>
</body></html>`
}

module.exports = router
