// ============================================================
// FILE: adip-backend/express-api/src/services/policyEnforcementService.js
// ROLE: Creates Azure Policy assignments after drift remediation
//
// findMatchingPolicies(changes) — maps diff paths to built-in policy IDs
// enforcePolicesForDrift(subscriptionId, resourceGroupId, changes)
//   — creates Policy Assignments via ARM SDK, records in Table Storage
//   — idempotent: skips if assignment already exists for this RG
//   — non-fatal: errors are logged but never block remediation
// ============================================================
'use strict'
const { PolicyClient }         = require('@azure/arm-policy')
const { DefaultAzureCredential } = require('@azure/identity')
const { TableClient }          = require('@azure/data-tables')
const policyMap                = require('../shared/policyMap.json')

const credential = new DefaultAzureCredential()

function assignmentsTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'policyAssignments')
}

// Maps diff change paths to matching built-in policy definitions
function findMatchingPolicies(changes) {
  const seen    = new Set()
  const matched = []
  for (const change of changes) {
    // Normalise path: strip spaces and arrows, lowercase, keep dots
    const path = (change.path || '').toLowerCase().replace(/\s*→\s*/g, '.').replace(/[^a-z0-9.]/g, '')
    for (const [mappedPath, policy] of Object.entries(policyMap)) {
      const norm = mappedPath.toLowerCase().replace(/[^a-z0-9.]/g, '')
      if ((path === norm || path.startsWith(norm + '.') || path.includes(norm)) && !seen.has(policy.policyDefinitionId)) {
        seen.add(policy.policyDefinitionId)
        matched.push(policy)
      }
    }
  }
  return matched
}

/**
 * Creates Azure Policy assignments for all policies matching the drifted fields.
 * @param {string} subscriptionId
 * @param {string} resourceGroupId
 * @param {Array}  changes — diff array from diffObjects()
 * @returns {Array} created assignments [{ displayName, assignmentId }]
 */
async function enforcePolicesForDrift(subscriptionId, resourceGroupId, changes) {
  console.log('[enforcePolicesForDrift] starts — rg:', resourceGroupId)
  const matched = findMatchingPolicies(changes)
  if (!matched.length) {
    console.log('[enforcePolicesForDrift] ends — no matching policies')
    return []
  }

  const policyClient = new PolicyClient(credential, subscriptionId)
  const scope        = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupId}`
  const tc           = assignmentsTable()
  const created      = []

  for (const policy of matched) {
    try {
      // Idempotency check — skip if already assigned to this RG
      const filter = `PartitionKey eq '${subscriptionId}' and resourceGroupId eq '${resourceGroupId}' and policyDefinitionId eq '${policy.policyDefinitionId}'`
      let exists = false
      for await (const _ of tc.listEntities({ queryOptions: { filter } })) { exists = true; break }
      if (exists) {
        console.log('[enforcePolicesForDrift] already assigned, skipping:', policy.displayName)
        continue
      }

      const assignmentName = `adip-${policy.policyDefinitionId.split('/').pop().slice(0, 24)}-${Date.now()}`
      const assignment = await policyClient.policyAssignments.create(scope, assignmentName, {
        policyDefinitionId: policy.policyDefinitionId,
        displayName:        `[ADIP] ${policy.displayName}`,
        description:        `Auto-assigned by ADIP after drift remediation on ${new Date().toISOString()}`,
        enforcementMode:    'Default',
      })

      await tc.upsertEntity({
        partitionKey:       subscriptionId,
        rowKey:             Buffer.from(assignmentName).toString('base64url').slice(0, 512),
        assignmentName,
        assignmentId:       assignment.id,
        policyDefinitionId: policy.policyDefinitionId,
        displayName:        policy.displayName,
        resourceGroupId,
        scope,
        createdAt:          new Date().toISOString(),
      }, 'Replace')

      created.push({ displayName: policy.displayName, assignmentId: assignment.id })
      console.log('[enforcePolicesForDrift] created:', policy.displayName)
    } catch (err) {
      // Non-fatal — policy failure must never block remediation
      console.log('[enforcePolicesForDrift] non-fatal error for', policy.displayName, ':', err.message)
    }
  }

  console.log('[enforcePolicesForDrift] ends — created:', created.length)
  return created
}

module.exports = { enforcePolicesForDrift, findMatchingPolicies }
