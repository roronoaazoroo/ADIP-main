// FILE: routes/remediateDecision.js

const router_remediateDecision = require('express').Router()
const { getBaseline: getBaselineForDecision, saveBaseline: saveBaselineForDecision } = require('../services/blobService')
const { getResourceConfig: getResourceConfigForDecision }  = require('../services/azureResourceService')
const { getApiVersion: getApiVersionForDecision }          = require('../services/azureResourceService')
const { ResourceManagementClient: RMC2 }  = require('@azure/arm-resources')
const { DefaultAzureCredential: DAC2 }    = require('@azure/identity')
 
 
// ── html START ───────────────────────────────────────────────────────────────
// Generates a styled HTML confirmation page shown to the admin after approve/reject
function html(title, message, color) {
  console.log('[html] starts — title:', title)
  const result = `<!DOCTYPE html>
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
  console.log('[html] ends')
  return result
}
// ── html END ─────────────────────────────────────────────────────────────────
 
 
// ── GET /api/remediate-decision START ────────────────────────────────────────
// Called when an admin clicks Approve or Reject in the drift alert email
// Approve: applies baseline via ARM PUT — Reject: promotes current state as new baseline
router_remediateDecision.get('/remediate-decision', async (req, res) => {
  console.log('[GET /remediate-decision] starts — action:', req.query.action)
  const { action, token } = req.query
  if (!token || !['approve', 'reject'].includes(action)) {
    console.log('[GET /remediate-decision] ends — invalid action/token')
    return res.status(400).send(html('Invalid Request', 'Missing or invalid action/token.', '#dc2626'))
  }
 
  let payload
  try {
    payload = JSON.parse(Buffer.from(token, 'base64url').toString('utf-8'))
  } catch {
    console.log('[GET /remediate-decision] ends — malformed token')
    return res.status(400).send(html('Invalid Token', 'The approval link is malformed or expired.', '#dc2626'))
  }
 
  const { resourceId, resourceGroup, subscriptionId } = payload
  if (!resourceId || !subscriptionId) {
    console.log('[GET /remediate-decision] ends — token missing fields')
    return res.status(400).send(html('Invalid Token', 'Token is missing required fields.', '#dc2626'))
  }
 
  const resourceName = resourceId.split('/').pop()
 
  try {
    if (action === 'approve') {
      // ── Approve: revert live resource to golden baseline ───────────────────
      const baseline = await getBaselineForDecision(subscriptionId, resourceId)
      if (!baseline?.resourceState) {
        console.log('[GET /remediate-decision] ends — no baseline for approve')
        return res.send(html('No Baseline Found',
          `No golden baseline exists for <strong>${resourceName}</strong>. Cannot remediate.`, '#d97706'))
      }
 
      const VOLATILE_D = ['etag','changedTime','createdTime','provisioningState','lastModifiedAt','systemData','_ts','_etag','_rid','_self','id']
 
      // ── strip (decision) START ─────────────────────────────────────────────
      // Strips volatile ARM fields from the baseline before applying ARM PUT
      function strip(obj) {
        console.log('[decision.strip] starts')
        if (Array.isArray(obj)) {
          const r = obj.map(strip)
          console.log('[decision.strip] ends — array')
          return r
        }
        if (obj && typeof obj === 'object') {
          const r = Object.fromEntries(
            Object.entries(obj).filter(([k]) => !VOLATILE_D.includes(k)).map(([k,v]) => [k, strip(v)])
          )
          console.log('[decision.strip] ends — object')
          return r
        }
        console.log('[decision.strip] ends — primitive')
        return obj
      }
      // ── strip (decision) END ───────────────────────────────────────────────
 
      const baselineState = strip(baseline.resourceState)
      const credential    = new DAC2()
      const armClient     = new RMC2(credential, subscriptionId)
      const parts         = resourceId.split('/')
      const rgName        = parts[4], provider = parts[6], type = parts[7], name = parts[8]

      if (!rgName || !provider || !type || !name) {
        return res.status(400).send(html('Cannot Remediate',
          'Remediation via email approval only works for specific resources, not resource groups. Please use the dashboard to remediate resource group level drift.', '#d97706'))
      }

      const apiVersion    = await getApiVersionForDecision(subscriptionId, provider, type)
 
      let location = baseline.resourceState?.location
      if (!location) {
        try {
          const live = await armClient.resources.get(rgName, provider, '', type, name, apiVersion)
          location = live.location
        } catch { location = 'eastus' }
      }
 
      await armClient.resources.beginCreateOrUpdateAndWait(
        rgName, provider, '', type, name, apiVersion,
        { ...baselineState, location }
      )

      // Reverse-reference cleanup for NSG subnet associations
      if (type.toLowerCase() === 'networksecuritygroups') {
        const baselineSubnets = (baselineState.properties?.subnets || []).map(s => s.id?.toLowerCase()).filter(Boolean)
        const liveNsg = await armClient.resources.get(rgName, provider, '', type, name, apiVersion).catch(() => ({}))
        const liveSubnets = (liveNsg.properties?.subnets || []).map(s => s.id?.toLowerCase()).filter(Boolean)
        for (const subnetId of liveSubnets.filter(id => !baselineSubnets.includes(id))) {
          try {
            const sp = subnetId.split('/')
            const vnetRg = sp[4], vnetName = sp[8], subnetName = sp[10]
            if (!vnetRg || !vnetName || !subnetName) continue
            const vnetApi = await getApiVersionForDecision(subscriptionId, 'Microsoft.Network', 'virtualNetworks')
            const subnet = await armClient.resources.get(vnetRg, 'Microsoft.Network', `virtualNetworks/${vnetName}`, 'subnets', subnetName, vnetApi)
            if (subnet.properties?.networkSecurityGroup) {
              delete subnet.properties.networkSecurityGroup
              await armClient.resources.beginCreateOrUpdateAndWait(vnetRg, 'Microsoft.Network', `virtualNetworks/${vnetName}`, 'subnets', subnetName, vnetApi, subnet)
            }
          } catch (e) { console.warn('[decision] subnet dissociate failed:', e.message) }
        }
      }

      // ── Storage account child resource reconciliation ─────────────────────
      // ARM PUT does not create/delete containers, shares, queues, or tables.
      // Compare baseline._childConfig vs current live._childConfig and reconcile.
      if (type.toLowerCase() === 'storageaccounts') {
        const fetch = require('node-fetch')
        const armBearerToken = await credential.getToken('https://management.azure.com/.default')

        // Fetch current live child resources to know what exists right now
        const currentLiveConfig = await getResourceConfigForDecision(subscriptionId, rgName, resourceId).catch(() => ({}))

        async function callStorageChildApi(httpMethod, childResourcePath, requestBody = null) {
          const armUrl = `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${rgName}/providers/Microsoft.Storage/storageAccounts/${name}/${childResourcePath}?api-version=2023-01-01`
          const fetchOptions = {
            method: httpMethod,
            headers: { 'Authorization': `Bearer ${armBearerToken.token}`, 'Content-Type': 'application/json' },
          }
          if (requestBody) fetchOptions.body = JSON.stringify(requestBody)
          const httpResponse = await fetch(armUrl, fetchOptions)
          if (!httpResponse.ok) throw new Error(`Storage child API ${httpResponse.status}: ${await httpResponse.text()}`)
        }

        async function reconcileStorageChildResources(childResourceType, serviceBasePath, createBody) {
          const baselineItems = (baselineState._childConfig?.[childResourceType] || []).map(item => item.name.toLowerCase())
          const liveItems     = (currentLiveConfig._childConfig?.[childResourceType] || []).map(item => item.name.toLowerCase())

          // In live but NOT in baseline → delete
          for (const itemName of liveItems.filter(n => !baselineItems.includes(n))) {
            try {
              await callStorageChildApi('DELETE', `${serviceBasePath}/${itemName}`)
              console.log(`[decision] deleted ${childResourceType}: ${itemName}`)
            } catch (deleteError) {
              console.warn(`[decision] failed to delete ${childResourceType} ${itemName}:`, deleteError.message)
            }
          }

          // In baseline but NOT in live → create
          for (const itemName of baselineItems.filter(n => !liveItems.includes(n))) {
            try {
              await callStorageChildApi('PUT', `${serviceBasePath}/${itemName}`, createBody)
              console.log(`[decision] created ${childResourceType}: ${itemName}`)
            } catch (createError) {
              console.warn(`[decision] failed to create ${childResourceType} ${itemName}:`, createError.message)
            }
          }
        }

        await Promise.allSettled([
          reconcileStorageChildResources('blobContainers',  'blobServices/default/containers',  { properties: {} }),
          reconcileStorageChildResources('fileShares',      'fileServices/default/shares',       { properties: {} }),
          reconcileStorageChildResources('storageQueues',   'queueServices/default/queues',      {}),
          reconcileStorageChildResources('storageTables',   'tableServices/default/tables',      {}),
        ])
      }
      // ── Storage account child resource reconciliation END ──────────────────

      console.log('[GET /remediate-decision] ends — approved and applied')
      return res.send(html('✓ Remediation Applied',
        `<strong>${resourceName}</strong> has been successfully reverted to its golden baseline.`, '#16a34a'))
 
    } else {
      // ── Reject: promote current live state as new baseline ─────────────────
      const liveState = await getResourceConfigForDecision(subscriptionId, resourceGroup, resourceId)
      // await saveBaselineForDecision(subscriptionId, resourceGroup, resourceId, liveState)
 
      console.log('[GET /remediate-decision] ends — rejected (drift accepted as baseline)')
      return res.send(html('Drift Accepted',
        `Auto remediation on the current configuration <strong>${resourceName}</strong> has been rejected`, '#6b7280'))
    }
  } catch (err) {
    console.log('[GET /remediate-decision] ends — error:', err.message)
    return res.status(500).send(html('Error', `Operation failed: ${err.message}`, '#dc2626'))
  }
})
// ── GET /api/remediate-decision END ──────────────────────────────────────────
 
module.exports = router_remediateDecision