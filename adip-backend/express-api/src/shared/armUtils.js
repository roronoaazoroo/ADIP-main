'use strict'

// FILE: shared/armUtils.js
// ROLE: Shared ARM PUT utilities — volatile field stripping for remediation

// Used by: remediate.js, remediateDecision.js
// Extracted to eliminate DRY violation (same constants + strip function in both files)

// Fields ARM rejects on PUT because they are managed by ARM itself

const VOLATILE_FIELDS = [
  'etag', 'changedTime', 'createdTime', 'provisioningState',
  'lastModifiedAt', 'systemData', '_ts', '_etag', '_rid', '_self', 'id',
]

// Additional read-only fields specific to certain resource types
const READONLY_FIELDS = [
  // VM: runtime state fields
  'instanceView', 'powerState', 'statuses', 'resources', 'latestModelApplied', 'vmId', 'timeCreated',
  // NSG: system-managed rules and back-references
  'defaultSecurityRules', 'resourceGuid', 'networkInterfaces', 'subnets',
]

/**
 * Recursively strips volatile and read-only fields from an ARM resource object
 * before applying an ARM PUT. Without stripping, ARM returns 400 "Cannot parse the request".
 * @param {*} obj - Any value (object, array, primitive)
 * @returns Cleaned copy safe for ARM PUT
 */
function stripVolatileFields(obj) {
  if (Array.isArray(obj)) return obj.map(stripVolatileFields)
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj)
        .filter(([fieldName]) => !VOLATILE_FIELDS.includes(fieldName) && !READONLY_FIELDS.includes(fieldName))
        .map(([fieldName, fieldValue]) => [fieldName, stripVolatileFields(fieldValue)])
    )
  }
  return obj
}

module.exports = { stripVolatileFields, VOLATILE_FIELDS, READONLY_FIELDS }
