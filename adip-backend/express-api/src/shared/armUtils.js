'use strict'

// FILE: shared/armUtils.js
// ROLE: Shared ARM PUT utilities — volatile field stripping for remediation

// Fields ARM rejects on PUT because they are managed by ARM itself
const VOLATILE_FIELDS = [
  'etag', 'changedTime', 'createdTime', 'provisioningState',
  'lastModifiedAt', 'systemData', '_ts', '_etag', '_rid', '_self', 'id',
]

// Read-only fields ARM rejects or ignores on PUT — resource-type specific
const READONLY_FIELDS = [
  // Common ARM
  'resourceGuid',
  // VM: system-assigned, immutable after creation
  'vmId', 'timeCreated', 'instanceView', 'powerState', 'statuses',
  'resources', 'latestModelApplied',
  // VM osProfile: immutable after provisioning
  'adminUsername', 'adminPassword', 'computerName',
  // VM storageProfile: disk identity is immutable
  'diskSizeGB', 'createOption',
  // VM networkProfile: NIC IDs are references, not settable via VM PUT
  // NSG: system-managed back-references
  'defaultSecurityRules', 'networkInterfaces', 'subnets',
]

// Top-level VM properties that are entirely read-only and must be omitted from PUT
const VM_READONLY_TOP = ['vmId', 'timeCreated', 'instanceView', 'resources']

// Nested path segments whose entire subtree should be stripped for VMs
// Key = parent property name, Value = child keys to remove
const VM_READONLY_NESTED = {
  osDisk:       ['name', 'managedDisk'],   // disk identity assigned by ARM
  storageProfile: [],                       // handled via osDisk above
}

/**
 * Recursively strips volatile and read-only fields from an ARM resource object
 * before applying an ARM PUT. Without stripping, ARM returns 400 "Cannot parse the request".
 * @param {*} obj - Any value (object, array, primitive)
 * @param {string} [parentKey] - Parent key name for context-aware stripping
 * @returns Cleaned copy safe for ARM PUT
 */
function stripVolatileFields(obj, parentKey = '') {
  if (Array.isArray(obj)) return obj.map(item => stripVolatileFields(item, parentKey))
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj)
        .filter(([fieldName]) => {
          if (VOLATILE_FIELDS.includes(fieldName)) return false
          if (READONLY_FIELDS.includes(fieldName)) return false
          // Strip nested osDisk identity fields
          if (parentKey === 'osDisk' && ['name', 'managedDisk'].includes(fieldName)) return false
          return true
        })
        .map(([fieldName, fieldValue]) => [fieldName, stripVolatileFields(fieldValue, fieldName)])
    )
  }
  return obj
}

module.exports = { stripVolatileFields, VOLATILE_FIELDS, READONLY_FIELDS }
