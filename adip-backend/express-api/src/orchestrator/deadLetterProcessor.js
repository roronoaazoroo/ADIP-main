// ============================================================
// deadLetterProcessor.js — Handles failed/orphaned workflows
// Recovers on startup. Processes poison events.
// ============================================================
'use strict'
const { WorkflowStateManager, STATES, TERMINAL_STATES } = require('./workflowStateManager')
const { WorkflowLockManager } = require('./workflowLockManager')
const { AuditLogger } = require('./auditLogger')

class DeadLetterProcessor {
  /**
   * Run on server startup: recover stale workflows, release stale locks.
   */
  async recoverOnStartup(tenantId) {
    const recovered = { workflows: 0, locks: 0 }

    // Recover stale locks
    recovered.locks = await WorkflowLockManager.recoverStaleLocks(tenantId)

    // Find workflows stuck in non-terminal states
    const stale = await WorkflowStateManager.findRecoverable(tenantId)
    for (const wf of stale) {
      const age = Date.now() - new Date(wf.updatedAt || wf.createdAt).getTime()

      // If stuck for more than 1 hour, dead-letter it
      if (age > 60 * 60 * 1000) {
        await WorkflowStateManager.transition(wf.partitionKey, wf.rowKey, STATES.DEAD_LETTERED).catch(() => {})
        await AuditLogger.log(wf.partitionKey, wf.rowKey, { event: 'dead_letter', detail: `Stale workflow (${Math.round(age / 60000)}min old) moved to dead letter` })
        await WorkflowLockManager.releaseAll(wf.partitionKey, wf.rowKey).catch(() => {})
        recovered.workflows++
      } else if (wf.status === STATES.RUNNING || wf.status === STATES.RETRYING) {
        // Recently stuck — mark for retry
        await WorkflowStateManager.transition(wf.partitionKey, wf.rowKey, STATES.RETRYING, { retryCount: (wf.retryCount || 0) + 1 }).catch(() => {})
        recovered.workflows++
      }
    }

    if (recovered.workflows > 0 || recovered.locks > 0) {
      console.log(`[Orchestrator] Recovery: ${recovered.workflows} workflows, ${recovered.locks} locks recovered`)
    }

    return recovered
  }

  /**
   * Check for timed-out workflows.
   */
  async processTimeouts(tenantId) {
    const { TableClient } = require('@azure/data-tables')
    const tc = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'orchestratorWorkflows')
    const now = new Date().toISOString()
    let timedOut = 0

    for await (const entity of tc.listEntities({
      queryOptions: { filter: `PartitionKey eq '${tenantId}' and status eq '${STATES.WAITING_APPROVAL}'` }
    })) {
      if (entity.timeoutAt && entity.timeoutAt < now) {
        await WorkflowStateManager.transition(tenantId, entity.rowKey, STATES.TIMED_OUT)
        await AuditLogger.log(tenantId, entity.rowKey, { event: 'workflow.timeout', detail: 'Approval timeout exceeded' })
        await WorkflowLockManager.releaseAll(tenantId, entity.rowKey).catch(() => {})
        timedOut++
      }
    }

    return timedOut
  }
}

module.exports = { DeadLetterProcessor: new DeadLetterProcessor() }
