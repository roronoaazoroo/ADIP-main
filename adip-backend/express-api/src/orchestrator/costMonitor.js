// ============================================================
// costMonitor.js — AI token budgeting and cost tracking
// Prevents runaway AI costs. Degrades gracefully.
// ============================================================
'use strict'

const MONTHLY_TOKEN_BUDGET = 500000 // 500k tokens/month default
const PER_TENANT_DAILY_LIMIT = 50000 // 50k tokens/day per tenant

class CostMonitor {
  constructor() {
    this.usage = new Map() // tenantId → { tokens, date }
    this.monthlyTotal = 0
    this.monthStart = new Date().toISOString().slice(0, 7) // YYYY-MM
  }

  /**
   * Check if AI call is within budget. Returns { allowed, reason }.
   */
  checkBudget(tenantId) {
    const currentMonth = new Date().toISOString().slice(0, 7)
    if (currentMonth !== this.monthStart) {
      this.monthlyTotal = 0
      this.monthStart = currentMonth
      this.usage.clear()
    }

    if (this.monthlyTotal >= MONTHLY_TOKEN_BUDGET) {
      return { allowed: false, reason: 'Monthly AI token budget exhausted' }
    }

    const today = new Date().toISOString().slice(0, 10)
    const tenantUsage = this.usage.get(tenantId)
    if (tenantUsage && tenantUsage.date === today && tenantUsage.tokens >= PER_TENANT_DAILY_LIMIT) {
      return { allowed: false, reason: 'Daily per-tenant AI limit reached' }
    }

    return { allowed: true }
  }

  /**
   * Record token usage after an AI call.
   */
  recordUsage(tenantId, tokens) {
    this.monthlyTotal += tokens
    const today = new Date().toISOString().slice(0, 10)
    const existing = this.usage.get(tenantId)
    if (existing && existing.date === today) {
      existing.tokens += tokens
    } else {
      this.usage.set(tenantId, { tokens, date: today })
    }
  }

  /**
   * Should we use AI or fallback to rules?
   * Low-value events (low severity, tag-only) skip AI to save cost.
   */
  shouldUseAI(event) {
    const severity = (event.severity || '').toLowerCase()
    if (severity === 'low') return false // Rules are sufficient
    if (event.changes?.length === 1 && event.changes[0]?.path?.includes('tags')) return false

    const budget = this.checkBudget(event.tenantId || 'default')
    return budget.allowed
  }

  getStats() {
    return { monthlyTotal: this.monthlyTotal, budget: MONTHLY_TOKEN_BUDGET, utilization: `${(this.monthlyTotal / MONTHLY_TOKEN_BUDGET * 100).toFixed(1)}%` }
  }
}

module.exports = { CostMonitor: new CostMonitor() }
