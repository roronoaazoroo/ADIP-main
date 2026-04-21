const { PolicyInsightsClient } = require('@azure/arm-policyinsights')
const { DefaultAzureCredential } = require('@azure/identity')

const credential = new DefaultAzureCredential()


// ── getPolicyCompliance START ────────────────────────────────────────────────
// Queries Azure Policy compliance state for a specific resource or resource group (read-only)
async function getPolicyCompliance(subscriptionId, resourceGroupName, resourceId = null) {
  console.log('[getPolicyCompliance] starts — subscriptionId:', subscriptionId, 'rg:', resourceGroupName, 'resourceId:', resourceId)
  const policyClient       = new PolicyInsightsClient(credential, subscriptionId)
  const policyStateResults = []

  if (resourceId) {
    // Build the full ARM scope path required by the Policy Insights API
    const resourceIdParts   = resourceId.split('/')
    const providerNamespace = resourceIdParts[6]
    const resourceTypeName  = resourceIdParts[7]
    const resourceName      = resourceIdParts[8]
    const resourceScopePath = `subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/${providerNamespace}/${resourceTypeName}/${resourceName}`

    for await (const policyState of policyClient.policyStates.listQueryResultsForResource(
      'latest', resourceScopePath, { queryOptions: { top: 50 } }
    )) {
      policyStateResults.push(formatPolicyState(policyState))
    }
  } else {
    for await (const policyState of policyClient.policyStates.listQueryResultsForResourceGroup(
      'latest', subscriptionId, resourceGroupName, { queryOptions: { top: 100 } }
    )) {
      policyStateResults.push(formatPolicyState(policyState))
    }
  }

  const nonCompliantStates = policyStateResults.filter(state => state.complianceState === 'NonCompliant')
  const compliantStates    = policyStateResults.filter(state => state.complianceState === 'Compliant')

  const complianceSummary = {
    total:        policyStateResults.length,
    nonCompliant: nonCompliantStates.length,
    compliant:    compliantStates.length,
    summary:      nonCompliantStates.length === 0 ? 'compliant' : 'non-compliant',
    violations:   nonCompliantStates,
  }
  console.log('[getPolicyCompliance] ends — total:', policyStateResults.length, 'nonCompliant:', nonCompliantStates.length)
  return complianceSummary
}
// ── getPolicyCompliance END ──────────────────────────────────────────────────


// ── formatState START ────────────────────────────────────────────────────────
// Maps a raw PolicyInsights state object to a clean, serialisable result shape
// Maps a raw PolicyInsights state object to a clean serialisable shape
function formatPolicyState(rawPolicyState) {
  console.log('[formatPolicyState] starts')
  const formattedState = {
    complianceState:        rawPolicyState.complianceState,
    policyAssignmentName:   rawPolicyState.policyAssignmentName,
    policyDefinitionName:   rawPolicyState.policyDefinitionName,
    policyDefinitionAction: rawPolicyState.policyDefinitionAction,
    resourceId:             rawPolicyState.resourceId,
    resourceType:           rawPolicyState.resourceType,
    timestamp:              rawPolicyState.timestamp,
  }
  console.log('[formatPolicyState] ends — state:', formattedState.complianceState)
  return formattedState
}
// ── formatState END ──────────────────────────────────────────────────────────

module.exports = { getPolicyCompliance }