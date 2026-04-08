'use strict'
const { CRITICAL_PATHS } = require('./constants')

/**
 * Classifies drift severity from a diff results array.
 * Works with both our custom diff format {path, type} and deep-diff format {path[], kind}.
 */
function classifySeverity(diffs) {
  if (!diffs || !diffs.length) return 'none'

  // Support both diff formats
  const isRemoved = (d) => d.type === 'removed' || d.kind === 'D'
  const getPath   = (d) => d.path
    ? (Array.isArray(d.path) ? d.path.join('.') : d.path)
    : ''

  if (diffs.some(isRemoved)) return 'critical'

  const tagChanges = diffs.filter(d => getPath(d).includes('tags'))
  if (tagChanges.length >= 3) return 'critical'

  if (diffs.some(d => CRITICAL_PATHS.some(p => getPath(d).startsWith(p)))) return 'high'
  if (diffs.length > 5) return 'medium'
  return 'low'
}

module.exports = { classifySeverity }
