// ============================================================
// FILE: shared/sanitize.js
// ROLE: Input sanitization utilities for OData and general use
// ============================================================
'use strict'

/**
 * Escape single quotes in OData filter values to prevent injection.
 * OData uses '' (double single-quote) as escape for '.
 */
function odataEscape(value) {
  if (typeof value !== 'string') return String(value || '')
  return value.replace(/'/g, "''")
}

/**
 * Build a safe OData filter string.
 * Usage: odataFilter('PartitionKey', 'eq', userInput)
 */
function odataFilter(field, op, value) {
  return `${field} ${op} '${odataEscape(value)}'`
}

module.exports = { odataEscape, odataFilter }
