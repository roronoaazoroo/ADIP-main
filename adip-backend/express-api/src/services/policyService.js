'use strict'
const { PolicyInsightsClient } = require('@azure/arm-policyinsights')
const { DefaultAzureCredential } = require('@azure/identity')

const credential = new DefaultAzureCredential()

// Max results per query — kept as named constants to avoid magic numbers
const MAX_RESOURCE_POLICY_RESULTS      = 50
const MAX_RESOURCE_GROUP_POLICY_RESULTS = 100


// ── getPolicyCompliance START ────────────────────────────────────────────────
// Queries Azure Policy compliance state for a specific resource or resource group (read-only)
async function getPolicyCompliance(subscriptionId, resourceGroupName, resourceId = null) {
  console.log('[getPolicyCompliance] starts — subscriptionId:', subscriptionId, 'rg:', resourceGroupName, 'resourceId:', resourceId)

  // Validate required inputs before making any API calls
  if (!subscriptionId || !resourceGroupName) {
    throw new Error('getPolicyCompliance requires subscriptionId and resourceGroupName')
  }

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
      'latest', resourceScopePath, { queryOptions: { top: MAX_RESOURCE_POLICY_RESULTS } }
    )) {
      policyStateResults.push(formatPolicyState(policyState))
    }
  } else {
    for await (const policyState of policyClient.policyStates.listQueryResultsForResourceGroup(
      'latest', subscriptionId, resourceGroupName, { queryOptions: { top: MAX_RESOURCE_GROUP_POLICY_RESULTS } }
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
function formatPolicyState(rawPolicyState) {
  return {
    complianceState:        rawPolicyState.complianceState,
    policyAssignmentName:   rawPolicyState.policyAssignmentName,
    policyDefinitionName:   rawPolicyState.policyDefinitionName,
    policyDefinitionAction: rawPolicyState.policyDefinitionAction,
    resourceId:             rawPolicyState.resourceId,
    resourceType:           rawPolicyState.resourceType,
    timestamp:              rawPolicyState.timestamp,
  }
}
// ── formatState END ──────────────────────────────────────────────────────────

module.exports = { getPolicyCompliance }
