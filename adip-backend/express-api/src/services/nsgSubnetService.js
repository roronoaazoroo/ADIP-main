// ============================================================
// FILE: adip-backend/express-api/src/services/nsgSubnetService.js
// ROLE: NSG ↔ Subnet association/dissociation logic
//       Extracted from remediate.js and remediateDecision.js (was duplicated)
// ============================================================
'use strict'
const { getApiVersion } = require('./azureResourceService')

/**
 * Reconciles NSG subnet associations between baseline and live state.
 * Dissociates subnets that shouldn't be linked, re-associates ones that should.
 */
async function reconcileNsgSubnets(armClient, subscriptionId, resourceId, baselineState, rgName) {
  const vnetApiVersion = await getApiVersion(subscriptionId, 'Microsoft.Network', 'virtualNetworks')
  const baselineSubnetIds = (baselineState.properties?.subnets || []).map(s => s.id?.toLowerCase()).filter(Boolean)

  const parts = resourceId.split('/')
  const nsgProvider = parts[6], nsgType = parts[7], nsgName = parts[8]
  const nsgApiVersion = await getApiVersion(subscriptionId, nsgProvider, nsgType)
  const currentNsg = await armClient.resources.get(rgName, nsgProvider, '', nsgType, nsgName, nsgApiVersion).catch(() => ({}))
  const liveSubnetIds = (currentNsg.properties?.subnets || []).map(s => s.id?.toLowerCase()).filter(Boolean)

  // Dissociate subnets that are in live but not in baseline
  for (const subnetId of liveSubnetIds.filter(id => !baselineSubnetIds.includes(id))) {
    try {
      const sp = subnetId.split('/')
      const vnetRg = sp[4], vnetName = sp[8], subnetName = sp[10]
      if (!vnetRg || !vnetName || !subnetName) continue
      const subnetConfig = await armClient.resources.get(vnetRg, 'Microsoft.Network', `virtualNetworks/${vnetName}`, 'subnets', subnetName, vnetApiVersion)
      if (subnetConfig.properties?.networkSecurityGroup) {
        delete subnetConfig.properties.networkSecurityGroup
        await armClient.resources.beginCreateOrUpdateAndWait(vnetRg, 'Microsoft.Network', `virtualNetworks/${vnetName}`, 'subnets', subnetName, vnetApiVersion, subnetConfig)
      }
    } catch {}
  }

  // Re-associate subnets that are in baseline but not in live
  for (const subnetId of baselineSubnetIds.filter(id => !liveSubnetIds.includes(id))) {
    try {
      const sp = subnetId.split('/')
      const vnetRg = sp[4], vnetName = sp[8], subnetName = sp[10]
      if (!vnetRg || !vnetName || !subnetName) continue
      const subnetConfig = await armClient.resources.get(vnetRg, 'Microsoft.Network', `virtualNetworks/${vnetName}`, 'subnets', subnetName, vnetApiVersion)
      subnetConfig.properties = subnetConfig.properties || {}
      subnetConfig.properties.networkSecurityGroup = { id: resourceId }
      await armClient.resources.beginCreateOrUpdateAndWait(vnetRg, 'Microsoft.Network', `virtualNetworks/${vnetName}`, 'subnets', subnetName, vnetApiVersion, subnetConfig)
    } catch {}
  }
}

module.exports = { reconcileNsgSubnets }
