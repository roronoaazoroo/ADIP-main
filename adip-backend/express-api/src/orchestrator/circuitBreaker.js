// ============================================================
// circuitBreaker.js — Protects against cascading failures
// Tracks failure rates per service. Opens circuit after threshold.
// ============================================================
'use strict'

const STATES = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' }

class CircuitBreaker {
  constructor(name, { failureThreshold = 5, resetTimeout = 30000, halfOpenMax = 2 } = {}) {
    this.name = name
    this.state = STATES.CLOSED
    this.failures = 0
    this.successes = 0
    this.failureThreshold = failureThreshold
    this.resetTimeout = resetTimeout
    this.halfOpenMax = halfOpenMax
    this.lastFailure = null
    this.halfOpenAttempts = 0
  }

  async execute(fn) {
    if (this.state === STATES.OPEN) {
      if (Date.now() - this.lastFailure > this.resetTimeout) {
        this.state = STATES.HALF_OPEN
        this.halfOpenAttempts = 0
      } else {
        throw new Error(`Circuit breaker [${this.name}] is OPEN`)
      }
    }

    if (this.state === STATES.HALF_OPEN && this.halfOpenAttempts >= this.halfOpenMax) {
      this.state = STATES.OPEN
      this.lastFailure = Date.now()
      throw new Error(`Circuit breaker [${this.name}] half-open limit reached`)
    }

    try {
      const result = await fn()
      this._onSuccess()
      return result
    } catch (error) {
      this._onFailure()
      throw error
    }
  }

  _onSuccess() {
    if (this.state === STATES.HALF_OPEN) {
      this.state = STATES.CLOSED
      this.failures = 0
    }
    this.successes++
  }

  _onFailure() {
    this.failures++
    this.lastFailure = Date.now()
    if (this.state === STATES.HALF_OPEN) {
      this.state = STATES.OPEN
      this.halfOpenAttempts++
    } else if (this.failures >= this.failureThreshold) {
      this.state = STATES.OPEN
    }
  }

  getState() {
    return { name: this.name, state: this.state, failures: this.failures, successes: this.successes }
  }

  reset() {
    this.state = STATES.CLOSED
    this.failures = 0
    this.halfOpenAttempts = 0
  }
}

// Singleton breakers for key services
const breakers = {
  openai: new CircuitBreaker('openai', { failureThreshold: 3, resetTimeout: 60000 }),
  arm: new CircuitBreaker('arm', { failureThreshold: 5, resetTimeout: 30000 }),
  email: new CircuitBreaker('email', { failureThreshold: 3, resetTimeout: 45000 }),
}

module.exports = { CircuitBreaker, breakers }
