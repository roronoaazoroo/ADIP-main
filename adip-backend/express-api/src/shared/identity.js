'use strict'
const { execSync } = require('child_process')

const _cache = {}

/**
 * Resolves an Azure caller identity to a human-readable display name.
 * - Email addresses and display names are returned as-is.
 * - GUIDs (object IDs) are resolved via Azure AD (user then service principal).
 * - Results are cached in-process.
 */
async function resolveIdentity(caller) {
  if (!caller) return null
  if (caller.includes(' ') || caller.includes('@')) return caller
  if (_cache[caller] !== undefined) return _cache[caller]
  try {
    let name = null
    try { name = execSync(`az ad user show --id ${caller} --query displayName -o tsv 2>/dev/null`, { timeout: 5000 }).toString().trim() } catch {}
    if (!name) try { name = execSync(`az ad sp show --id ${caller} --query displayName -o tsv 2>/dev/null`, { timeout: 5000 }).toString().trim() } catch {}
    _cache[caller] = name || caller
  } catch { _cache[caller] = caller }
  return _cache[caller]
}

module.exports = { resolveIdentity }
