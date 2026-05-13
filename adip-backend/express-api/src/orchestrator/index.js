// ============================================================
// index.js — Orchestrator entry point
// Initializes all modules, wires event sources, starts recovery.
// ============================================================
'use strict'
const { EventRouter } = require('./eventRouter')
const { WorkflowStateManager } = require('./workflowStateManager')
const { WorkflowLockManager } = require('./workflowLockManager')
const { RuleEngine } = require('./ruleEngine')
const { AIReasoner } = require('./aiReasoner')
const { PlanExecutor } = require('./planExecutor')
const { AuditLogger } = require('./auditLogger')
const { MemoryStore } = require('./memoryStore')
const { RetryManager } = require('./retryManager')
const { DeadLetterProcessor } = require('./deadLetterProcessor')
const { CostMonitor } = require('./costMonitor')
const { breakers } = require('./circuitBreaker')
const { PromptBuilder } = require('./promptBuilder')

const ORCHESTRATOR_TABLES = [
  'orchestratorWorkflows',
  'orchestratorSteps',
  'orchestratorAudit',
  'orchestratorLocks',
  'orchestratorMemory',
]

/**
 * Initialize the orchestrator. Call once on server startup.
 */
async function initOrchestrator(defaultTenantId = 'default') {
  // Ensure tables exist
  const { TableClient } = require('@azure/data-tables')
  for (const table of ORCHESTRATOR_TABLES) {
    try {
      await TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, table).createTable()
    } catch (e) {
      if (!e.message?.includes('TableAlreadyExists')) throw e
    }
  }

  // Recover from previous crash
  await DeadLetterProcessor.recoverOnStartup(defaultTenantId)

  // Start timeout checker (every 5 minutes)
  setInterval(() => DeadLetterProcessor.processTimeouts(defaultTenantId).catch(() => {}), 5 * 60 * 1000)

  console.log('[Orchestrator] Initialized — tables ready, recovery complete')
}

module.exports = {
  initOrchestrator,
  EventRouter,
  WorkflowStateManager,
  WorkflowLockManager,
  RuleEngine,
  AIReasoner,
  PlanExecutor,
  AuditLogger,
  MemoryStore,
  RetryManager,
  DeadLetterProcessor,
  CostMonitor,
  PromptBuilder,
  breakers,
  ORCHESTRATOR_TABLES,
}
