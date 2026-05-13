// ============================================================
// eventRouter.js — Central event ingestion point
// Deduplicates, enriches, sequences, and routes to AI Reasoner.
// Handles drift storms via batching and backpressure.
// ============================================================
'use strict'
const crypto = require('crypto')
const { WorkflowStateManager, STATES } = require('./workflowStateManager')
const { WorkflowLockManager } = require('./workflowLockManager')
const { RuleEngine } = require('./ruleEngine')
const { AIReasoner } = require('./aiReasoner')
const { PlanExecutor } = require('./planExecutor')
const { AuditLogger } = require('./auditLogger')
const { MemoryStore } = require('./memoryStore')

// Deduplication window (100ms)
const recentEvents = new Map()
const DEDUP_WINDOW = 100
const MAX_CONCURRENT_WORKFLOWS = 20
let activeWorkflows = 0

// Drift storm detection
let eventCountWindow = 0
let windowStart = Date.now()
const STORM_THRESHOLD = 50 // 50 events per minute = storm
const STORM_WINDOW = 60000

class EventRouter {
  /**
   * Process an incoming event. This is the main entry point.
   */
  async process(event) {
    // 1. Deduplicate
    const eventId = event.eventId || this._generateEventId(event)
    if (this._isDuplicate(eventId)) {
      return { status: 'deduplicated', eventId }
    }

    // 2. Drift storm detection
    if (this._isStorm()) {
      return this._handleStorm(event, eventId)
    }

    // 3. Backpressure check
    if (activeWorkflows >= MAX_CONCURRENT_WORKFLOWS) {
      await AuditLogger.log(event.tenantId || 'system', '', { event: 'backpressure', detail: `${activeWorkflows} active workflows, queueing event` })
      return { status: 'queued', reason: 'backpressure' }
    }

    // 4. Check if resource already has active workflow
    const tenantId = event.tenantId || 'default'
    const existing = await WorkflowStateManager.findActiveForResource(tenantId, event.resourceId || '')
    if (existing.length > 0) {
      await AuditLogger.log(tenantId, existing[0].workflowId, { event: 'event.merged', detail: `New event merged into existing workflow` })
      return { status: 'merged', existingWorkflow: existing[0].workflowId }
    }

    // 5. Create workflow
    const workflow = await WorkflowStateManager.create(tenantId, { ...event, eventId })
    await AuditLogger.log(tenantId, workflow.workflowId, { event: 'workflow.created', detail: `Event: ${event.type || event.eventType}`, resourceId: event.resourceId, severity: event.severity })

    // 6. Enrich and plan (async, non-blocking)
    activeWorkflows++
    setImmediate(() => this._processWorkflow(workflow, event).finally(() => { activeWorkflows-- }))

    return { status: 'accepted', workflowId: workflow.workflowId }
  }

  /**
   * Internal: run the full workflow pipeline.
   */
  async _processWorkflow(workflow, event) {
    const { tenantId, workflowId } = workflow

    try {
      // Transition: CREATED → ENRICHING
      await WorkflowStateManager.transition(tenantId, workflowId, STATES.ENRICHING)

      // Get historical memory for this resource
      const memory = await MemoryStore.findSimilar(tenantId, event.resourceId || '', 5)

      // Transition: ENRICHING → PLANNING
      await WorkflowStateManager.transition(tenantId, workflowId, STATES.PLANNING)

      // Evaluate rule constraints
      const constraints = RuleEngine.evaluate(event, RuleEngine.getTenantPolicy(tenantId))

      // If blocked by rules, stop immediately
      if (constraints.blocked) {
        await AuditLogger.log(tenantId, workflowId, { event: 'workflow.blocked', detail: constraints.blockReason })
        await WorkflowStateManager.transition(tenantId, workflowId, STATES.CANCELLED)
        return
      }

      // AI Reasoning (or fallback)
      const plan = await AIReasoner.reason(event, constraints, memory)
      await AuditLogger.logAIDecision(tenantId, workflowId, plan)

      // Persist plan
      await WorkflowStateManager.transition(tenantId, workflowId, STATES.PLANNING, {
        planJson: JSON.stringify(plan),
        reasoningJson: JSON.stringify({ reasoning: plan.reasoning, confidence: plan.confidence, source: plan._source }),
        fallbackJson: JSON.stringify(plan.fallback || {}),
        stepsTotal: plan.steps?.length || 0,
      })

      // Handle no-action plans
      if (plan.steps?.length === 1 && plan.steps[0].action === 'no-action') {
        await WorkflowStateManager.transition(tenantId, workflowId, STATES.COMPLETED)
        await MemoryStore.record(tenantId, { resourceId: event.resourceId, eventType: event.type, severity: event.severity, action: 'no-action', outcome: 'completed', reasoning: plan.reasoning })
        return
      }

      // Execute plan
      const result = await PlanExecutor.execute(workflow, plan)

      if (result.status === 'waiting_approval') {
        // Workflow paused — will resume when approval arrives
        if (global.io) global.io.emit('workflow.waiting', { workflowId, step: 'await-approval' })
      }

    } catch (error) {
      await AuditLogger.log(tenantId, workflowId, { event: 'workflow.error', detail: error.message })
      await WorkflowStateManager.transition(tenantId, workflowId, STATES.FAILED).catch(() => {})
      await WorkflowLockManager.releaseAll(tenantId, workflowId).catch(() => {})
    }
  }

  /**
   * Resume a workflow after external event (approval, schedule trigger).
   */
  async resume(tenantId, workflowId, eventType, data = {}) {
    await AuditLogger.log(tenantId, workflowId, { event: `resume.${eventType}`, detail: JSON.stringify(data).slice(0, 100) })
    return PlanExecutor.resume(tenantId, workflowId, data)
  }

  /**
   * Human override: pause, cancel, skip, force-rollback.
   */
  async override(tenantId, workflowId, action, actor, reason) {
    await AuditLogger.logOverride(tenantId, workflowId, actor, action, reason)

    switch (action) {
      case 'pause':
        return WorkflowStateManager.transition(tenantId, workflowId, STATES.PAUSED)
      case 'cancel':
        await WorkflowLockManager.releaseAll(tenantId, workflowId)
        return WorkflowStateManager.transition(tenantId, workflowId, STATES.CANCELLED)
      case 'resume':
        return this.resume(tenantId, workflowId, 'manual-resume', { actor })
      default:
        throw new Error(`Unknown override action: ${action}`)
    }
  }

  // ── Deduplication ──────────────────────────────────────────────────────────

  _isDuplicate(eventId) {
    const now = Date.now()
    if (recentEvents.has(eventId)) {
      const ts = recentEvents.get(eventId)
      if (now - ts < DEDUP_WINDOW) return true
    }
    recentEvents.set(eventId, now)
    // Cleanup old entries
    if (recentEvents.size > 1000) {
      for (const [k, v] of recentEvents) {
        if (now - v > DEDUP_WINDOW * 10) recentEvents.delete(k)
      }
    }
    return false
  }

  _generateEventId(event) {
    const content = `${event.resourceId || ''}:${event.type || ''}:${event.timestamp || ''}:${event.caller || ''}`
    return crypto.createHash('md5').update(content).digest('hex')
  }

  // ── Drift Storm ────────────────────────────────────────────────────────────

  _isStorm() {
    const now = Date.now()
    if (now - windowStart > STORM_WINDOW) {
      eventCountWindow = 0
      windowStart = now
    }
    eventCountWindow++
    return eventCountWindow > STORM_THRESHOLD
  }

  _handleStorm(event, eventId) {
    // During storm: only process critical, batch the rest
    if (event.severity === 'critical') {
      return null // Let it through
    }
    return { status: 'storm-batched', eventId, message: 'Drift storm detected — non-critical events batched' }
  }
}

module.exports = { EventRouter: new EventRouter() }
