// ============================================================
// FILE: src/utils/driftUtils.js
// ROLE: Pure utility functions for drift comparison UI
//       Extracted from ComparisonPage.jsx for reusability/testability
// ============================================================

/**
 * Strips volatile/Azure-assigned fields from ARM state before comparison.
 */
export function normaliseState(state) {
  if (!state) return state
  const STRIP = ['provisioningState', 'etag', 'changedTime', 'createdTime', 'lastModifiedAt', 'systemData', 'resourceGuid', '_ts', '_etag', '_rid', '_self']
  const clone = JSON.parse(JSON.stringify(state))
  function walk(obj) {
    if (!obj || typeof obj !== 'object') return
    STRIP.forEach(k => delete obj[k])
    Object.values(obj).forEach(v => { if (typeof v === 'object') walk(v) })
  }
  walk(clone)
  return clone
}

/**
 * Filters out volatile/noise diffs that aren't meaningful drift.
 */
const VOLATILE_PATHS = ['macAddress', 'dnsSettings', 'internalDomainNameSuffix', 'ipAddress', 'primary', 'virtualMachine', 'LastOwnershipUpdateTime', 'uniqueId', 'creationData', 'timeCreated', 'diskSizeBytes', 'diskState', 'tier']

export function filterVolatile(diffs) {
  return diffs.filter(d => {
    const path = d.path || ''
    const oldVal = JSON.stringify(d.oldValue || '')
    const newVal = JSON.stringify(d.newValue || '')
    const combined = path + ' ' + oldVal + ' ' + newVal
    if (combined.includes('Microsoft.Compute/disks') || combined.includes('OsDisk') || combined.includes('_disk')) return false
    if (d.type === 'array-changed' || d.type === 'array-added' || d.type === 'array-removed' || d.type === 'array-reordered') return false
    return !VOLATILE_PATHS.some(v => combined.includes(v))
  })
}

/**
 * Client-side severity classification from diff array.
 */
export function classifySeverity(differences) {
  if (!differences?.length) return 'low'
  const hasDeleted = differences.some(d => d.type === 'removed')
  if (hasDeleted) return 'critical'
  const SECURITY_FIELDS = ['networkAcls', 'accessPolicies', 'securityRules', 'sku', 'location', 'identity', 'encryption']
  const hasSecurity = differences.some(d => SECURITY_FIELDS.some(f => (d.path || '').includes(f)))
  if (hasSecurity) return 'high'
  if (differences.length > 5) return 'medium'
  return 'low'
}

/**
 * Normalizes raw deep-diff output into display format.
 */
export function formatDifferences(rawDiff) {
  if (!rawDiff?.length) return []
  return rawDiff.map(d => ({
    path: d.path?.join?.(' → ') || d.path || '',
    type: d.kind === 'N' ? 'added' : d.kind === 'D' ? 'removed' : d.kind === 'A' ? 'array-changed' : 'modified',
    oldValue: d.lhs ?? d.oldValue ?? null,
    newValue: d.rhs ?? d.newValue ?? null,
  }))
}
