// ============================================================
// aiReasoner.js — AI decision engine with containment
// Calls OpenAI, validates response, applies rule constraints.
// Falls back to deterministic rules if AI unavailable.
// ============================================================
'use strict'
const { PromptBuilder } = require('./promptBuilder')
const { RuleEngine } = require('./ruleEngine')
const { breakers } = require('./circuitBreaker')
const { AuditLogger } = require('./auditLogger')

const PLAN_SCHEMA_KEYS = ['planName', 'confidence', 'reasoning', 'steps', 'fallback']
const VALID_ACTIONS = ['generate-cab', 'run-testing', 'request-approval', 'await-approval', 'snapshot-before', 'remediate', 'validate-after', 'update-baseline', 'enforce-policy', 'generate-report', 'notify-admin', 'suppress-drift', 'escalate', 'no-action', 'schedule-remediation']

class AIReasoner {
  constructor() {
    this.timeout = 12000
    this.maxTokens = 400
  }

  /**
   * Generate a plan for an event. Returns validated plan or fallback.
   */
  async reason(event, constraints, memory = []) {
    // If circuit breaker is open, go straight to fallback
    if (breakers.openai.state === 'OPEN') {
      return this._fallbackPlan(event, constraints, 'Circuit breaker open')
    }

    const systemPrompt = PromptBuilder.buildSystemPrompt()
    const userPrompt = PromptBuilder.buildEventPrompt(event, constraints, memory)

    let aiResponse
    try {
      aiResponse = await breakers.openai.execute(() => this._callAI(systemPrompt, userPrompt))
    } catch (e) {
      return this._fallbackPlan(event, constraints, `AI error: ${e.message}`)
    }

    // Parse and validate
    let plan
    try {
      plan = JSON.parse(aiResponse)
    } catch {
      // Retry once with simplified prompt
      try {
        aiResponse = await this._callAI(systemPrompt, 'Respond with a simple JSON plan for: ' + (event.severity || 'low') + ' severity drift. ' + userPrompt.slice(0, 300))
        plan = JSON.parse(aiResponse)
      } catch {
        return this._fallbackPlan(event, constraints, 'AI returned invalid JSON')
      }
    }

    // Validate schema
    if (!this._validateSchema(plan)) {
      return this._fallbackPlan(event, constraints, 'AI response failed schema validation')
    }

    // Validate actions
    plan.steps = (plan.steps || []).filter(s => VALID_ACTIONS.includes(s.action))
    if (plan.steps.length === 0) {
      return this._fallbackPlan(event, constraints, 'AI plan had no valid actions')
    }

    // Apply rule engine constraints
    const validation = RuleEngine.validatePlan(plan, constraints)
    if (!validation.valid) {
      await AuditLogger.log(event.tenantId || 'system', event.workflowId || '', {
        event: 'ai.plan_corrected',
        detail: `Violations: ${validation.violations.join('; ')}`,
      })
      plan = validation.correctedPlan || plan
    }

    // Confidence check
    if ((plan.confidence || 0) < 0.7 && !plan.steps.some(s => s.action === 'escalate')) {
      plan.steps.push({ action: 'escalate', target: 'admin', params: { reason: 'Low confidence decision' } })
    }

    plan._source = 'ai'
    return plan
  }

  /**
   * Deterministic fallback when AI is unavailable.
   */
  _fallbackPlan(event, constraints, reason) {
    const severity = (event.severity || 'low').toLowerCase()
    const steps = []

    steps.push({ action: 'snapshot-before', target: event.resourceId })

    if (constraints.blocked) {
      return { planName: 'blocked', confidence: 1.0, reasoning: constraints.blockReason, steps: [{ action: 'no-action' }], fallback: {}, _source: 'fallback', _fallbackReason: reason }
    }

    if (severity === 'critical' || severity === 'high' || constraints.requireApproval) {
      steps.push({ action: 'generate-cab', target: event.resourceId })
      steps.push({ action: 'request-approval', approvers: constraints.minApprovers || 1 })
      steps.push({ action: 'await-approval' })
      steps.push({ action: 'remediate', target: event.resourceId })
      steps.push({ action: 'validate-after', target: event.resourceId })
      steps.push({ action: 'update-baseline', target: event.resourceId })
      steps.push({ action: 'notify-admin', target: event.resourceId })
    } else if (constraints.autoRemediate) {
      steps.push({ action: 'remediate', target: event.resourceId })
      steps.push({ action: 'validate-after', target: event.resourceId })
      steps.push({ action: 'update-baseline', target: event.resourceId })
    } else {
      steps.push({ action: 'escalate', target: 'admin', params: { reason: 'No auto-remediate policy' } })
    }

    return {
      planName: `fallback-${severity}`,
      confidence: 1.0,
      reasoning: `Deterministic fallback: ${reason}`,
      steps,
      fallback: { onStepFailure: 'escalate', onTimeout: 'escalate' },
      _source: 'fallback',
      _fallbackReason: reason,
    }
  }

  _validateSchema(plan) {
    if (!plan || typeof plan !== 'object') return false
    if (!Array.isArray(plan.steps)) return false
    if (typeof plan.confidence !== 'number' || plan.confidence < 0 || plan.confidence > 1) plan.confidence = 0.5
    return true
  }

  async _callAI(systemPrompt, userPrompt) {
    const { callAI } = require('../services/aiOrchestrator')
    return await callAI(systemPrompt, userPrompt, { maxTokens: this.maxTokens, timeout: this.timeout })
  }
}

module.exports = { AIReasoner: new AIReasoner() }
