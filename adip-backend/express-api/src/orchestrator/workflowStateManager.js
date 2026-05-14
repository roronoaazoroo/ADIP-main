// ============================================================
// workflowStateManager.js — Persistent workflow state machine
// States: CREATED → ENRICHING → PLANNING → WAITING_APPROVAL →
//         RUNNING → COMPLETED/FAILED/CANCELLED/TIMED_OUT/ESCALATED
// All state persisted to Azure Table Storage. Survives restarts.
// ============================================================
'use strict'
const crypto = require('crypto')
const { TableClient } = require('@azure/data-tables')

const STATES = {
  CREATED: 'CREATED',
  ENRICHING: 'ENRICHING',
  PLANNING: 'PLANNING',
  WAITING_APPROVAL: 'WAITING_APPROVAL',
  SCHEDULED: 'SCHEDULED',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  RETRYING: 'RETRYING',
  ROLLING_BACK: 'ROLLING_BACK',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  TIMED_OUT: 'TIMED_OUT',
  ESCALATED: 'ESCALATED',
  DEAD_LETTERED: 'DEAD_LETTERED',
}

const VALID_TRANSITIONS = {
  CREATED: ['ENRICHING', 'CANCELLED'],
  ENRICHING: ['PLANNING', 'FAILED'],
  PLANNING: ['WAITING_APPROVAL', 'SCHEDULED', 'RUNNING', 'FAILED'],
  WAITING_APPROVAL: ['RUNNING', 'CANCELLED', 'TIMED_OUT', 'ESCALATED'],
  SCHEDULED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['COMPLETED', 'FAILED', 'PAUSED', 'ROLLING_BACK', 'RETRYING'],
  PAUSED: ['RUNNING', 'CANCELLED'],
  RETRYING: ['RUNNING', 'FAILED', 'DEAD_LETTERED'],
  ROLLING_BACK: ['FAILED', 'COMPLETED'],
  ESCALATED: ['RUNNING', 'CANCELLED', 'TIMED_OUT'],
}

const TERMINAL_STATES = ['COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'DEAD_LETTERED']

function workflowTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'orchestratorWorkflows')
}

function stepTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'orchestratorSteps')
}

class WorkflowStateManager {
  /**
   * Create a new workflow.
   */
  async create(tenantId, event) {
    const workflowId = `wf-${crypto.randomUUID()}`
    const now = new Date().toISOString()

    const workflow = {
      partitionKey: tenantId,
      rowKey: workflowId,
      workflowId,
      tenantId,
      eventId: event.eventId || crypto.randomUUID(),
      correlationId: event.correlationId || crypto.randomUUID(),
      causationId: event.causationId || event.eventId || '',
      resourceId: event.resourceId || '',
      resourceGroup: event.resourceGroup || '',
      subscriptionId: event.subscriptionId || '',
      eventType: event.type || '',
      severity: event.severity || '',
      status: STATES.CREATED,
      currentStepIndex: 0,
      planJson: '',
      contextJson: JSON.stringify(event),
      reasoningJson: '',
      fallbackJson: '',
      stepsCompleted: 0,
      stepsTotal: 0,
      retryCount: 0,
      maxRetries: 3,
      createdAt: now,
      updatedAt: now,
      completedAt: '',
      timeoutAt: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(), // 72h default
      lockedUntil: '',
      lockedBy: '',
      dryRun: event.dryRun || false,
      version: 1, // optimistic concurrency
    }

    await workflowTable().createEntity(workflow)
    return workflow
  }

  /**
   * Transition workflow to a new state. Validates transition is legal.
   */
  async transition(tenantId, workflowId, newState, metadata = {}) {
    const wf = await this.get(tenantId, workflowId)
    if (!wf) throw new Error(`Workflow ${workflowId} not found`)

    if (wf.status === newState) return wf // idempotent

    const allowed = VALID_TRANSITIONS[wf.status]
    if (!allowed || !allowed.includes(newState)) {
      throw new Error(`Invalid transition: ${wf.status} → ${newState}`)
    }

    const now = new Date().toISOString()
    const updates = {
      ...wf,
      status: newState,
      updatedAt: now,
      version: wf.version + 1,
      ...(TERMINAL_STATES.includes(newState) ? { completedAt: now } : {}),
      ...(metadata.planJson ? { planJson: metadata.planJson } : {}),
      ...(metadata.reasoningJson ? { reasoningJson: metadata.reasoningJson } : {}),
      ...(metadata.fallbackJson ? { fallbackJson: metadata.fallbackJson } : {}),
      ...(metadata.stepsTotal !== undefined ? { stepsTotal: metadata.stepsTotal } : {}),
      ...(metadata.currentStepIndex !== undefined ? { currentStepIndex: metadata.currentStepIndex } : {}),
      ...(metadata.stepsCompleted !== undefined ? { stepsCompleted: metadata.stepsCompleted } : {}),
      ...(metadata.retryCount !== undefined ? { retryCount: metadata.retryCount } : {}),
    }

    await workflowTable().upsertEntity(updates, 'Replace')
    return updates
  }

  /**
   * Get workflow by ID.
   */
  async get(tenantId, workflowId) {
    try {
      return await workflowTable().getEntity(tenantId, workflowId)
    } catch (e) {
      if (e.statusCode === 404) return null
      throw e
    }
  }

  /**
   * Find active workflow for a resource (for lock checking).
   */
  async findActiveForResource(tenantId, resourceId) {
    const tc = workflowTable()
    const results = []
    for await (const entity of tc.listEntities({
      queryOptions: { filter: `PartitionKey eq '${tenantId}' and resourceId eq '${resourceId}' and status ne 'COMPLETED' and status ne 'FAILED' and status ne 'CANCELLED' and status ne 'TIMED_OUT' and status ne 'DEAD_LETTERED'` }
    })) {
      results.push(entity)
    }
    return results
  }

  /**
   * List workflows needing recovery (stale RUNNING/RETRYING after restart).
   */
  async findRecoverable(tenantId) {
    const tc = workflowTable()
    const results = []
    for await (const entity of tc.listEntities({
      queryOptions: { filter: `PartitionKey eq '${tenantId}' and (status eq 'RUNNING' or status eq 'RETRYING' or status eq 'PAUSED')` }
    })) {
      results.push(entity)
    }
    return results
  }

  /**
   * Save a step execution record.
   */
  async saveStep(tenantId, workflowId, step) {
    const entity = {
      partitionKey: `${tenantId}_${workflowId}`,
      rowKey: step.stepId || `step-${step.index}-${Date.now()}`,
      workflowId,
      tenantId,
      stepName: step.name,
      stepIndex: step.index,
      status: step.status, // pending|running|completed|failed|skipped|compensated
      startedAt: step.startedAt || '',
      completedAt: step.completedAt || '',
      retries: step.retries || 0,
      outputJson: JSON.stringify(step.output || null),
      errorJson: JSON.stringify(step.error || null),
      compensationAction: step.compensationAction || '',
      compensated: step.compensated || false,
      correlationId: step.correlationId || '',
      idempotencyKey: step.idempotencyKey || '',
      durationMs: step.durationMs || 0,
    }
    await stepTable().upsertEntity(entity, 'Replace')
    return entity
  }

  /**
   * Get all steps for a workflow.
   */
  async getSteps(tenantId, workflowId) {
    const tc = stepTable()
    const results = []
    for await (const entity of tc.listEntities({
      queryOptions: { filter: `PartitionKey eq '${tenantId}_${workflowId}'` }
    })) {
      results.push(entity)
    }
    return results.sort((a, b) => (a.stepIndex || 0) - (b.stepIndex || 0))
  }

  /**
   * Check if a step already completed (idempotency).
   */
  async isStepCompleted(tenantId, workflowId, stepName) {
    const steps = await this.getSteps(tenantId, workflowId)
    return steps.some(s => s.stepName === stepName && s.status === 'completed')
  }
}

module.exports = { WorkflowStateManager: new WorkflowStateManager(), STATES, VALID_TRANSITIONS, TERMINAL_STATES }
