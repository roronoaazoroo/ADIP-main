// ============================================================
// auditLogger.js — Immutable audit log for all orchestrator decisions
// Append-only. Tamper-detectable via hash chain.
// ============================================================
'use strict'
const crypto = require('crypto')
const { TableClient } = require('@azure/data-tables')

function auditTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'orchestratorAudit')
}

let lastHash = '0000000000000000'

class AuditLogger {
  /**
   * Log an immutable audit entry with hash chain for tamper detection.
   */
  async log(tenantId, workflowId, entry) {
    const now = new Date().toISOString()
    const payload = {
      tenantId,
      workflowId,
      event: entry.event,
      detail: (entry.detail || '').slice(0, 500),
      actor: entry.actor || 'system',
      resourceId: entry.resourceId || '',
      severity: entry.severity || '',
      timestamp: now,
    }

    // Hash chain: each entry includes hash of previous entry
    const content = JSON.stringify(payload) + lastHash
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)
    lastHash = hash

    const entity = {
      partitionKey: `${tenantId}_${workflowId}`,
      rowKey: `${now}_${hash}`,
      ...payload,
      previousHash: lastHash,
      entryHash: hash,
      // Redact secrets from detail
      detail: this._redactSecrets(payload.detail),
    }

    try {
      await auditTable().createEntity(entity)
    } catch (e) {
      // Audit must never crash the system — log to console as fallback
      console.error('[AuditLogger] Failed to persist:', e.message, payload.event)
    }

    // Emit to frontend for live visibility
    if (global.io) {
      global.io.emit('debug.log', { category: 'Audit', message: `[${entry.event}] ${entry.detail || ''}`.slice(0, 100), timestamp: now })
    }

    return entity
  }

  /**
   * Log a workflow state transition.
   */
  async logTransition(tenantId, workflowId, fromState, toState, reason = '') {
    return this.log(tenantId, workflowId, {
      event: 'state.transition',
      detail: `${fromState} → ${toState}${reason ? ': ' + reason : ''}`,
    })
  }

  /**
   * Log an AI decision.
   */
  async logAIDecision(tenantId, workflowId, decision) {
    return this.log(tenantId, workflowId, {
      event: 'ai.decision',
      detail: `Action: ${decision.action || decision.plan?.name || 'unknown'} | Confidence: ${decision.confidence || 'N/A'} | Reasoning: ${(decision.reasoning || '').slice(0, 200)}`,
    })
  }

  /**
   * Log a human override.
   */
  async logOverride(tenantId, workflowId, actor, action, reason) {
    return this.log(tenantId, workflowId, {
      event: 'human.override',
      detail: `${actor} overrode: ${action}. Reason: ${reason}`,
      actor,
    })
  }

  /**
   * Log a step execution.
   */
  async logStep(tenantId, workflowId, stepName, status, detail = '') {
    return this.log(tenantId, workflowId, {
      event: `step.${status}`,
      detail: `${stepName}: ${detail}`.slice(0, 300),
    })
  }

  /**
   * Get full audit trail for a workflow.
   */
  async getTrail(tenantId, workflowId) {
    const tc = auditTable()
    const results = []
    for await (const entity of tc.listEntities({
      queryOptions: { filter: `PartitionKey eq '${tenantId}_${workflowId}'` }
    })) {
      results.push(entity)
    }
    return results.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  }

  _redactSecrets(text) {
    return (text || '')
      .replace(/[A-Za-z0-9+/=]{40,}/g, '[REDACTED]')
      .replace(/password["\s:=]+[^\s"]+/gi, 'password=[REDACTED]')
      .replace(/secret["\s:=]+[^\s"]+/gi, 'secret=[REDACTED]')
      .replace(/key["\s:=]+[A-Za-z0-9+/=]{20,}/gi, 'key=[REDACTED]')
  }
}

module.exports = { AuditLogger: new AuditLogger() }
