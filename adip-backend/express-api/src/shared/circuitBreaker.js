// ============================================================
// FILE: adip-backend/express-api/src/shared/circuitBreaker.js
// ROLE: Circuit breaker pattern for external service calls
//       Prevents cascade failures when OpenAI/ARM/external APIs are down
// ============================================================
'use strict'

class CircuitBreaker {
  constructor(name, options = {}) {
    this.name = name
    this.failureThreshold = options.failureThreshold || 5
    this.resetTimeout = options.resetTimeout || 30000
    this.failures = 0
    this.state = 'CLOSED' // CLOSED, OPEN, HALF_OPEN
    this.lastFailure = 0
  }

  async call(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastFailure > this.resetTimeout) {
        this.state = 'HALF_OPEN'
      } else {
        throw new Error(`[CircuitBreaker:${this.name}] Circuit OPEN — service unavailable`)
      }
    }

    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure()
      throw error
    }
  }

  onSuccess() {
    this.failures = 0
    this.state = 'CLOSED'
  }

  onFailure() {
    this.failures++
    this.lastFailure = Date.now()
    if (this.failures >= this.failureThreshold) {
      this.state = 'OPEN'
      console.warn(`[CircuitBreaker:${this.name}] Circuit OPENED after ${this.failures} failures`)
    }
  }

  getState() { return { name: this.name, state: this.state, failures: this.failures } }
}

// Shared breakers
const breakers = {
  openai: new CircuitBreaker('openai', { failureThreshold: 3, resetTimeout: 60000 }),
  arm: new CircuitBreaker('arm', { failureThreshold: 10, resetTimeout: 30000 }),
}

module.exports = { CircuitBreaker, breakers }
