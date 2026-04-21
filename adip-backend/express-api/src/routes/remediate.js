// FILE: routes/remediate.js

const router_remediate = require('express').Router()
const fetch = require('node-fetch')
const { ResourceManagementClient } = require('@azure/arm-resources')
const { DefaultAzureCredential } = require('@azure/identity')
const { getBaseline } = require('../services/blobService')
const { getResourceConfig, getApiVersion } = require('../services/azureResourceService')
const { diffObjects } = require('../shared/diff')
 
const VOLATILE_REM = ['etag', 'changedTime', 'createdTime', 'provisioningState', 'lastModifiedAt', 'systemData', '_ts', '_etag', '_rid', '_self', 'id']
 
 
// ── strip (remediate) START ──────────────────────────────────────────────────
// Strips volatile fields before applying an ARM PUT to prevent write conflicts
function strip(obj) {
  console.log('[remediate.strip] starts')
  if (Array.isArray(obj)) {
    const r = obj.map(strip)
    console.log('[remediate.strip] ends — array')
    return r
  }
  if (obj && typeof obj === 'object') {
    const r = Object.fromEntries(
      Object.entries(obj).filter(([k]) => !VOLATILE_REM.includes(k)).map(([k, v]) => [k, strip(v)])
    )
    console.log('[remediate.strip] ends — object')
    return r
  }
  console.log('[remediate.strip] ends — primitive')
  return obj
}
// ── strip (remediate) END ────────────────────────────────────────────────────
 
 
// ── POST /api/remediate START ────────────────────────────────────────────────
// Immediately reverts a resource to its golden baseline via ARM PUT (used for low severity)
router_remediate.post('/remediate', async (req, res) => {
  console.log('[POST /remediate] starts')
  const { subscriptionId, resourceGroupId, resourceId } = req.body
  if (!subscriptionId || !resourceGroupId || !resourceId) {
    console.log('[POST /remediate] ends — missing required fields')
    return res.status(400).json({ error: 'subscriptionId, resourceGroupId and resourceId required' })
  }
 
  try {
    const baseline = await getBaseline(subscriptionId, resourceId)
    if (!baseline?.resourceState) {
      console.log('[POST /remediate] ends — no baseline found')
      return res.status(404).json({ error: 'No golden baseline found for this resource' })
    }
 
    const baselineState = strip(baseline.resourceState)
    const liveRaw       = await getResourceConfig(subscriptionId, resourceGroupId, resourceId)
    const liveState     = strip(liveRaw)
    const differences   = diffObjects(liveState, baselineState)
 
    const logicAppUrl = process.env.ALERT_LOGIC_APP_URL
    const { classifySeverity } = require('../shared/severity')
    const remSeverity = classifySeverity(differences)
    if (logicAppUrl && ['critical', 'high'].includes(remSeverity)) fetch(logicAppUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resourceId, resourceGroup: resourceGroupId, subscriptionId, severity: remSeverity, changeCount: differences.length, detectedAt: new Date().toISOString() }) }).catch(() => {})
 
    const credential = new DefaultAzureCredential()
    const armClient  = new ResourceManagementClient(credential, subscriptionId)
    const parts      = resourceId.split('/')
    const provider   = parts[6]
    const type       = parts[7]
    const name       = parts[8]
    const rgName     = parts[4]
    const apiVersion = await getApiVersion(subscriptionId, provider, type)
 
    let location = baseline.resourceState?.location
    if (!location) {
      try { location = liveRaw.location } catch { location = 'westus2' }
    }
 
    await armClient.resources.beginCreateOrUpdateAndWait(
      rgName, provider, '', type, name, apiVersion,
      { ...baselineState, location }
    )

    // Reverse-reference cleanup for NSG subnet associations
    if (type.toLowerCase() === 'networksecuritygroups') {
      const baselineSubnets = (baselineState.properties?.subnets || []).map(s => s.id?.toLowerCase()).filter(Boolean)
      const liveSubnets     = (liveState.properties?.subnets    || []).map(s => s.id?.toLowerCase()).filter(Boolean)
      const toRemove        = liveSubnets.filter(id => !baselineSubnets.includes(id))
      for (const subnetId of toRemove) {
        try {
          const sp = subnetId.split('/')
          const vnetRg = sp[4], vnetName = sp[8], subnetName = sp[10]
          if (!vnetRg || !vnetName || !subnetName) continue
          const vnetApi = await getApiVersion(subscriptionId, 'Microsoft.Network', 'virtualNetworks')
          const subnet  = await armClient.resources.get(vnetRg, 'Microsoft.Network', `virtualNetworks/${vnetName}`, 'subnets', subnetName, vnetApi)
          if (subnet.properties?.networkSecurityGroup) {
            delete subnet.properties.networkSecurityGroup
            await armClient.resources.beginCreateOrUpdateAndWait(
              vnetRg, 'Microsoft.Network', `virtualNetworks/${vnetName}`, 'subnets', subnetName, vnetApi, strip(subnet)
            )
            console.log(`[remediate] dissociated subnet ${subnetName} from NSG ${name}`)
          }
        } catch (e) {
          console.warn(`[remediate] failed to dissociate subnet:`, e.message)
        }
      }
    }
 
    res.json({ remediated: true, resourceId, changeCount: differences.length,
      appliedBaseline: baselineState, previousLiveState: liveState })
    console.log('[POST /remediate] ends — applied baseline, changes:', differences.length)
  } catch (err) {
    console.log('[POST /remediate] ends — error:', err.message)
    res.status(500).json({ error: err.message })
  }
})
// ── POST /api/remediate END ──────────────────────────────────────────────────
 
module.exports = router_remediate
 
 