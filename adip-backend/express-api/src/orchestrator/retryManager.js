// ============================================================
// retryManager.js — Configurable retry with exponential backoff
// Supports per-step retry policies. Tracks attempts.
// ============================================================
'use strict'

const DEFAULT_POLICY = { maxRetries: 3, baseDelay: 2000, maxDelay: 30000, backoffFactor: 2 }

const STEP_POLICIES = {
  'remediate': { maxRetries: 2, baseDelay: 5000, maxDelay: 60000, backoffFactor: 2 },
  'generate-cab': { maxRetries: 1, baseDelay: 3000, maxDelay: 10000, backoffFactor: 2 },
  'request-approval': { maxRetries: 2, baseDelay: 2000, maxDelay: 15000, backoffFactor: 2 },
  'validate-after': { maxRetries: 3, baseDelay: 10000, maxDelay: 60000, backoffFactor: 2 },
  'update-baseline': { maxRetries: 2, baseDelay: 5000, maxDelay: 30000, backoffFactor: 2 },
  'enforce-policy': { maxRetries: 1, baseDelay: 3000, maxDelay: 10000, backoffFactor: 2 },
  'notify-admin': { maxRetries: 2, baseDelay: 1000, maxDelay: 5000, backoffFactor: 2 },
}

class RetryManager {
  /**
   * Execute a function with retry logic.
   * @returns { result, attempts, lastError }
   */
  async executeWithRetry(stepName, fn) {
    const policy = STEP_POLICIES[stepName] || DEFAULT_POLICY
    let attempts = 0
    let lastError = null

    while (attempts <= policy.maxRetries) {
      try {
        const result = await fn()
        return { result, attempts: attempts + 1, lastError: null }
      } catch (error) {
        lastError = error
        attempts++

        if (attempts > policy.maxRetries) break

        // Check if error is retryable
        if (!this._isRetryable(error)) break

        // Exponential backoff with jitter
        const delay = Math.min(
          policy.baseDelay * Math.pow(policy.backoffFactor, attempts - 1) + Math.random() * 1000,
          policy.maxDelay
        )
        await new Promise(r => setTimeout(r, delay))
      }
    }

    return { result: null, attempts, lastError }
  }

  getPolicy(stepName) {
    return STEP_POLICIES[stepName] || DEFAULT_POLICY
  }

  _isRetryable(error) {
    const msg = error.message || ''
    const code = error.statusCode || error.status || 0

    // Non-retryable: auth failures, not found, validation errors
    if (code === 401 || code === 403 || code === 404 || code === 400) return false
    if (msg.includes('not found') || msg.includes('unauthorized')) return false

    // Retryable: timeouts, 429, 5xx, network errors
    if (code === 429 || code >= 500) return true
    if (msg.includes('timeout') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT')) return true
    if (msg.includes('throttl') || msg.includes('rate limit')) return true

    return true // Default: retry
  }
}

module.exports = { RetryManager: new RetryManager() }
