// ============================================================
// FILE: adip-backend/express-api/src/shared/keyVault.js
// ROLE: Azure Key Vault integration for secrets management
//       Falls back to env vars when Key Vault is unavailable (local dev)
// ============================================================
'use strict'
const { SecretClient } = require('@azure/keyvault-secrets')
const { DefaultAzureCredential } = require('@azure/identity')

let _client = null
const _cache = new Map()
const CACHE_TTL = 5 * 60 * 1000 // 5 min

function getClient() {
  if (!_client) {
    const vaultUrl = process.env.KEY_VAULT_URL
    if (!vaultUrl) return null
    _client = new SecretClient(vaultUrl, new DefaultAzureCredential())
  }
  return _client
}

/**
 * Get a secret from Key Vault (with cache) or fall back to env var.
 * @param {string} name - Secret name in Key Vault (or env var name with hyphens→underscores)
 * @param {string} envFallback - Environment variable name to use as fallback
 */
async function getSecret(name, envFallback) {
  // Check cache
  const cached = _cache.get(name)
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.value

  // Try Key Vault
  const client = getClient()
  if (client) {
    try {
      const secret = await client.getSecret(name)
      _cache.set(name, { value: secret.value, ts: Date.now() })
      return secret.value
    } catch (e) {
      console.warn(`[keyVault] Failed to get secret '${name}': ${e.message}`)
    }
  }

  // Fallback to env var
  return process.env[envFallback || name.replace(/-/g, '_').toUpperCase()]
}

/**
 * Initialize all required secrets at startup.
 * Returns an object with resolved secret values.
 */
async function initSecrets() {
  const secrets = {
    storageConnectionString: await getSecret('storage-connection-string', 'STORAGE_CONNECTION_STRING'),
    jwtSecret: await getSecret('jwt-secret', 'JWT_SECRET'),
    openaiKey: await getSecret('openai-key', 'AZURE_OPENAI_KEY'),
    commsConnectionString: await getSecret('comms-connection-string', 'COMMS_CONNECTION_STRING'),
    approvalSecret: await getSecret('approval-secret', 'APPROVAL_SECRET'),
  }
  return secrets
}

module.exports = { getSecret, initSecrets }
