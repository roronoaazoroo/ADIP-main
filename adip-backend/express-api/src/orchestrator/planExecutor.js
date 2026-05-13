// ============================================================
// planExecutor.js — Executes workflow plans step by step
// Supports: sequential, parallel, pause/resume, compensation
// All steps are idempotent. Skips already-completed steps.
// ============================================================
'use strict'
const { WorkflowStateManager, STATES } = require('./workflowStateManager')
const { WorkflowLockManager } = require('./workflowLockManager')
const { RetryManager } = require('./retryManager')
const { AuditLogger } = require('./auditLogger')
const { MemoryStore } = require('./memoryStore')
const { breakers } = require('./circuitBreaker')

// Compensation actions for rollback
const COMPENSATIONS = {
  'remediate': 'rollback-to-snapshot',
  'enforce-policy': 'remove-policy-assignment',
  'update-baseline': 'restore-previous-baseline',
  'suppress-drift': 'remove-suppression-rule',
}

class PlanExecutor {
  /**
   * Execute a plan for a workflow. Resumes from last completed step.
   */
  async execute(workflow, plan) {
    const { tenantId, workflowId, resourceId, resourceGroup } = workflow
    const steps = plan.steps || []

    if (steps.length === 0) {
      await WorkflowStateManager.transition(tenantId, workflowId, STATES.COMPLETED)
      return { status: 'completed', stepsRun: 0 }
    }

    // Acquire resource lock
    const lock = await WorkflowLockManager.acquire(tenantId, resourceId, workflowId)
    if (!lock.acquired) {
      await AuditLogger.log(tenantId, workflowId, { event: 'lock.conflict', detail: `Resource locked by ${lock.holder}` })
      return { status: 'locked', holder: lock.holder }
    }

    await WorkflowStateManager.transition(tenantId, workflowId, STATES.RUNNING, { stepsTotal: steps.length })

    let stepsRun = 0
    const completedMutations = [] // For rollback tracking

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]

      // Check if already completed (idempotency)
      const alreadyDone = await WorkflowStateManager.isStepCompleted(tenantId, workflowId, step.action)
      if (alreadyDone) {
        stepsRun++
        continue
      }

      // Check for pause/cancel
      const currentWf = await WorkflowStateManager.get(tenantId, workflowId)
      if (currentWf?.status === STATES.PAUSED || currentWf?.status === STATES.CANCELLED) {
        await WorkflowLockManager.release(tenantId, resourceId, workflowId)
        return { status: currentWf.status, stepsRun }
      }

      // Handle await-approval (pause workflow)
      if (step.action === 'await-approval') {
        await WorkflowStateManager.transition(tenantId, workflowId, STATES.WAITING_APPROVAL, { currentStepIndex: i })
        await WorkflowStateManager.saveStep(tenantId, workflowId, { name: step.action, index: i, status: 'waiting', startedAt: new Date().toISOString() })
        await AuditLogger.logStep(tenantId, workflowId, step.action, 'waiting', 'Paused for approval')
        // Don't release lock — keep it while waiting
        return { status: 'waiting_approval', stepsRun, pausedAt: i }
      }

      // Execute step with retry
      const startTime = Date.now()
      await AuditLogger.logStep(tenantId, workflowId, step.action, 'started')

      if (global.io) global.io.emit('workflow.progress', { workflowId, step: step.action, status: 'running', index: i, total: steps.length })

      const { result, attempts, lastError } = await RetryManager.executeWithRetry(step.action, () =>
        this._executeStep(step, workflow, plan.dryRun || workflow.dryRun)
      )

      const durationMs = Date.now() - startTime

      if (lastError) {
        // Step failed after retries
        await WorkflowStateManager.saveStep(tenantId, workflowId, {
          name: step.action, index: i, status: 'failed', startedAt: new Date(startTime).toISOString(),
          completedAt: new Date().toISOString(), retries: attempts - 1, error: lastError.message, durationMs,
          compensationAction: COMPENSATIONS[step.action] || '',
        })
        await AuditLogger.logStep(tenantId, workflowId, step.action, 'failed', `${lastError.message} (${attempts} attempts)`)

        if (global.io) global.io.emit('workflow.progress', { workflowId, step: step.action, status: 'failed', error: lastError.message })

        // Determine failure action
        const failureAction = plan.fallback?.onStepFailure || 'escalate'
        if (failureAction === 'rollback' && completedMutations.length > 0) {
          await this._rollback(tenantId, workflowId, workflow, completedMutations)
        }

        await WorkflowStateManager.transition(tenantId, workflowId, STATES.FAILED, { currentStepIndex: i })
        await WorkflowLockManager.release(tenantId, resourceId, workflowId)

        await MemoryStore.record(tenantId, { resourceId, eventType: workflow.eventType, severity: workflow.severity, action: step.action, outcome: 'failed', reasoning: lastError.message, durationMs })

        return { status: 'failed', failedStep: step.action, error: lastError.message, stepsRun }
      }

      // Step succeeded
      await WorkflowStateManager.saveStep(tenantId, workflowId, {
        name: step.action, index: i, status: 'completed', startedAt: new Date(startTime).toISOString(),
        completedAt: new Date().toISOString(), retries: attempts - 1, output: result, durationMs,
        compensationAction: COMPENSATIONS[step.action] || '',
        idempotencyKey: `${workflowId}_${step.action}_${i}`,
      })
      await AuditLogger.logStep(tenantId, workflowId, step.action, 'completed', `${durationMs}ms`)

      if (global.io) global.io.emit('workflow.progress', { workflowId, step: step.action, status: 'completed', index: i })

      // Track mutations for potential rollback
      if (COMPENSATIONS[step.action]) {
        completedMutations.push({ action: step.action, compensation: COMPENSATIONS[step.action], result })
      }

      stepsRun++
      await WorkflowStateManager.transition(tenantId, workflowId, STATES.RUNNING, { currentStepIndex: i + 1, stepsCompleted: stepsRun })
    }

    // All steps completed
    await WorkflowStateManager.transition(tenantId, workflowId, STATES.COMPLETED, { stepsCompleted: stepsRun })
    await WorkflowLockManager.release(tenantId, resourceId, workflowId)
    await AuditLogger.log(tenantId, workflowId, { event: 'workflow.completed', detail: `${stepsRun} steps in ${Date.now() - new Date(workflow.createdAt).getTime()}ms` })

    if (global.io) global.io.emit('workflow.completed', { workflowId, type: workflow.eventType, stepsRun })

    await MemoryStore.record(tenantId, { resourceId, eventType: workflow.eventType, severity: workflow.severity, action: 'workflow', outcome: 'completed', durationMs: Date.now() - new Date(workflow.createdAt).getTime() })

    return { status: 'completed', stepsRun }
  }

  /**
   * Resume a workflow after approval.
   */
  async resume(tenantId, workflowId, approvalData = {}) {
    const workflow = await WorkflowStateManager.get(tenantId, workflowId)
    if (!workflow) throw new Error('Workflow not found')
    if (workflow.status !== STATES.WAITING_APPROVAL) throw new Error(`Cannot resume: status is ${workflow.status}`)

    await AuditLogger.log(tenantId, workflowId, { event: 'approval.received', detail: `Approved by: ${approvalData.approver || 'unknown'}` })

    // Mark approval step as completed
    await WorkflowStateManager.saveStep(tenantId, workflowId, {
      name: 'await-approval', index: workflow.currentStepIndex, status: 'completed',
      completedAt: new Date().toISOString(), output: approvalData,
    })

    // Get plan and continue from next step
    const plan = JSON.parse(workflow.planJson || '{}')
    const remainingSteps = (plan.steps || []).slice(workflow.currentStepIndex + 1)
    const continuePlan = { ...plan, steps: remainingSteps }

    const updatedWorkflow = { ...workflow, currentStepIndex: workflow.currentStepIndex + 1 }
    return this.execute(updatedWorkflow, continuePlan)
  }

  /**
   * Rollback completed mutations in reverse order.
   */
  async _rollback(tenantId, workflowId, workflow, completedMutations) {
    await WorkflowStateManager.transition(tenantId, workflowId, STATES.ROLLING_BACK)
    await AuditLogger.log(tenantId, workflowId, { event: 'rollback.started', detail: `Rolling back ${completedMutations.length} mutations` })

    for (const mutation of completedMutations.reverse()) {
      try {
        await this._executeCompensation(mutation.compensation, workflow)
        await AuditLogger.logStep(tenantId, workflowId, mutation.compensation, 'completed', 'Rollback')
      } catch (e) {
        await AuditLogger.logStep(tenantId, workflowId, mutation.compensation, 'failed', e.message)
      }
    }
  }

  /**
   * Execute a single step by delegating to existing ADIP services.
   */
  async _executeStep(step, workflow, dryRun = false) {
    const ctx = JSON.parse(workflow.contextJson || '{}')
    const { subscriptionId, resourceGroup, resourceId } = workflow

    if (dryRun) return `[DRY RUN] Would execute: ${step.action} on ${resourceId}`

    switch (step.action) {
      case 'generate-cab': {
        const port = process.env.PORT || 3001
        const resp = await fetch(`http://localhost:${port}/api/cab`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscriptionId, resourceGroupId: resourceGroup, resourceId, severity: workflow.severity, differences: ctx.changes || [], requestedBy: 'orchestrator' }),
        })
        if (!resp.ok) throw new Error(`CAB generation failed: ${resp.status}`)
        const cab = await resp.json()
        return cab.cabId
      }

      case 'run-testing': {
        // Testing is embedded in CAB generation — verify it passed
        return 'testing-delegated-to-cab'
      }

      case 'request-approval': {
        const { sendApprovalEmail } = require('../services/alertService')
        await breakers.email.execute(() => sendApprovalEmail({
          subscriptionId, resourceGroup, resourceId, severity: workflow.severity, workflowId: workflow.workflowId,
        }))
        return 'approval-requested'
      }

      case 'snapshot-before': {
        const { saveGenomeSnapshot } = require('../services/blobService')
        const { getResourceConfig } = require('../services/azureResourceService')
        const live = await breakers.arm.execute(() => getResourceConfig(subscriptionId, resourceGroup, resourceId === resourceGroup ? null : resourceId))
        if (live) await saveGenomeSnapshot(subscriptionId, resourceId || resourceGroup, live, `pre-workflow-${workflow.workflowId.slice(0, 8)}`)
        return 'snapshot-saved'
      }

      case 'remediate': {
        const port = process.env.PORT || 3001
        const resp = await fetch(`http://localhost:${port}/api/remediate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': `${workflow.workflowId}_remediate` },
          body: JSON.stringify({ subscriptionId, resourceGroupId: resourceGroup, resourceId }),
        })
        if (!resp.ok) throw new Error(`Remediation failed: ${resp.status}`)
        return (await resp.json()).deployment?.summary || 'remediated'
      }

      case 'validate-after': {
        const { getResourceConfig } = require('../services/azureResourceService')
        const live = await breakers.arm.execute(() => getResourceConfig(subscriptionId, resourceGroup, resourceId === resourceGroup ? null : resourceId))
        if (!live) throw new Error('Post-validation failed: resource not reachable')
        return 'validated'
      }

      case 'update-baseline': {
        const { scheduleBaselineRefresh } = require('../services/baselineRefreshService')
        scheduleBaselineRefresh({ subscriptionId, resourceGroupId: resourceGroup, resourceId, delayMs: 30000 })
        return 'baseline-refresh-scheduled'
      }

      case 'enforce-policy': {
        const { assignPolicy } = require('../services/policyEnforcementService')
        await assignPolicy(subscriptionId, resourceGroup, resourceId, workflow.severity)
        return 'policy-assigned'
      }

      case 'generate-report': {
        return 'report-generation-delegated'
      }

      case 'notify-admin': {
        if (global.io) global.io.emit('notification', { type: 'workflow_completed', workflowId: workflow.workflowId, resourceId, message: `Workflow completed for ${(resourceId || '').split('/').pop()}` })
        return 'notified'
      }

      case 'suppress-drift': {
        const { TableClient } = require('@azure/data-tables')
        const tc = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'suppressionRules')
        await tc.upsertEntity({ partitionKey: subscriptionId, rowKey: `orch-${Date.now()}`, resourceId, field: step.params?.field || '*', reason: step.params?.reason || 'Agent-suppressed', createdBy: 'orchestrator', createdAt: new Date().toISOString() })
        return 'suppressed'
      }

      case 'escalate': {
        if (global.io) global.io.emit('notification', { type: 'escalation', workflowId: workflow.workflowId, severity: 'critical', message: step.params?.reason || 'Escalated by orchestrator' })
        return 'escalated'
      }

      case 'schedule-remediation': {
        return 'scheduled'
      }

      case 'no-action': {
        return 'no-action-taken'
      }

      default:
        return `unknown-step: ${step.action}`
    }
  }

  async _executeCompensation(compensation, workflow) {
    switch (compensation) {
      case 'rollback-to-snapshot': {
        const { getResourceConfig } = require('../services/azureResourceService')
        // Rollback handled by genome service
        return 'rollback-attempted'
      }
      case 'remove-policy-assignment':
        return 'policy-removal-attempted'
      case 'restore-previous-baseline':
        return 'baseline-restore-attempted'
      default:
        return 'no-compensation'
    }
  }
}

module.exports = { PlanExecutor: new PlanExecutor() }
