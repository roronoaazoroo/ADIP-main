// ============================================================
// memoryStore.js — Agent memory: past decisions, patterns, outcomes
// Enables learning from history. Tenant-isolated.
// ============================================================
'use strict'
const { TableClient } = require('@azure/data-tables')

function memoryTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'orchestratorMemory')
}

class MemoryStore {
  /**
   * Record a decision and its outcome.
   */
  async record(tenantId, entry) {
    const entity = {
      partitionKey: tenantId,
      rowKey: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      resourceId: entry.resourceId || '',
      eventType: entry.eventType || '',
      severity: entry.severity || '',
      action: entry.action || '',
      outcome: entry.outcome || '', // completed|failed|overridden
      reasoning: (entry.reasoning || '').slice(0, 300),
      confidence: entry.confidence || 0,
      durationMs: entry.durationMs || 0,
      overriddenBy: entry.overriddenBy || '',
      timestamp: new Date().toISOString(),
    }
    try {
      await memoryTable().createEntity(entity)
    } catch {}
    return entity
  }

  /**
   * Find similar past decisions for a resource.
   */
  async findSimilar(tenantId, resourceId, limit = 10) {
    const tc = memoryTable()
    const results = []
    for await (const entity of tc.listEntities({
      queryOptions: { filter: `PartitionKey eq '${tenantId}' and resourceId eq '${resourceId}'` }
    })) {
      results.push(entity)
    }
    return results.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || '')).slice(0, limit)
  }

  /**
   * Find patterns: recurring drifts that keep getting approved.
   */
  async findRecurringApproved(tenantId, resourceId) {
    const history = await this.findSimilar(tenantId, resourceId, 20)
    const approved = history.filter(h => h.outcome === 'completed' && h.action === 'remediate')
    return approved.length >= 3 // If remediated 3+ times, it's recurring
  }

  /**
   * Get aggregate stats for a tenant.
   */
  async getStats(tenantId) {
    const tc = memoryTable()
    let total = 0, completed = 0, failed = 0, overridden = 0
    for await (const entity of tc.listEntities({
      queryOptions: { filter: `PartitionKey eq '${tenantId}'` }
    })) {
      total++
      if (entity.outcome === 'completed') completed++
      if (entity.outcome === 'failed') failed++
      if (entity.overriddenBy) overridden++
    }
    return { total, completed, failed, overridden, successRate: total ? (completed / total * 100).toFixed(1) : 0 }
  }
}

module.exports = { MemoryStore: new MemoryStore() }
