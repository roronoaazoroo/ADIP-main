// ============================================================
// workflowLockManager.js — Distributed resource locking
// Prevents concurrent workflows on the same resource.
// Supports parent-child locking (RG locks children).
// ============================================================
'use strict'
const { TableClient } = require('@azure/data-tables')

const DEFAULT_LOCK_TTL = 10 * 60 * 1000 // 10 minutes

function lockTable() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'orchestratorLocks')
}

class WorkflowLockManager {
  /**
   * Acquire a lock on a resource. Returns { acquired, lockId } or { acquired: false, holder }.
   */
  async acquire(tenantId, resourceId, workflowId, ttlMs = DEFAULT_LOCK_TTL) {
    const tc = lockTable()
    const lockKey = this._lockKey(resourceId)
    const now = Date.now()
    const expiresAt = new Date(now + ttlMs).toISOString()

    try {
      // Check existing lock
      const existing = await tc.getEntity(tenantId, lockKey).catch(() => null)

      if (existing) {
        // Check if lock is stale (expired)
        if (existing.expiresAt && new Date(existing.expiresAt).getTime() < now) {
          // Stale lock — reclaim
          await tc.deleteEntity(tenantId, lockKey)
        } else if (existing.workflowId === workflowId) {
          // Same workflow re-acquiring (idempotent)
          return { acquired: true, lockId: existing.rowKey }
        } else {
          // Held by another workflow
          return { acquired: false, holder: existing.workflowId, expiresAt: existing.expiresAt }
        }
      }

      // Acquire lock
      await tc.createEntity({
        partitionKey: tenantId,
        rowKey: lockKey,
        workflowId,
        resourceId,
        acquiredAt: new Date().toISOString(),
        expiresAt,
      })

      return { acquired: true, lockId: lockKey }
    } catch (e) {
      if (e.statusCode === 409) {
        // Race condition — another workflow acquired first
        return { acquired: false, holder: 'unknown (race)' }
      }
      throw e
    }
  }

  /**
   * Release a lock.
   */
  async release(tenantId, resourceId, workflowId) {
    const tc = lockTable()
    const lockKey = this._lockKey(resourceId)

    try {
      const existing = await tc.getEntity(tenantId, lockKey).catch(() => null)
      if (existing && existing.workflowId === workflowId) {
        await tc.deleteEntity(tenantId, lockKey)
        return true
      }
    } catch {}
    return false
  }

  /**
   * Acquire locks for a resource and its parent (RG-level lock).
   */
  async acquireWithParent(tenantId, resourceId, resourceGroup, workflowId, ttlMs = DEFAULT_LOCK_TTL) {
    // Lock the specific resource
    const resourceLock = await this.acquire(tenantId, resourceId, workflowId, ttlMs)
    if (!resourceLock.acquired) return resourceLock

    // Also lock at RG level to prevent RG-wide operations conflicting
    const rgLock = await this.acquire(tenantId, `rg:${resourceGroup}`, workflowId, ttlMs)
    if (!rgLock.acquired) {
      // Release resource lock if RG lock fails
      await this.release(tenantId, resourceId, workflowId)
      return rgLock
    }

    return { acquired: true, locks: [resourceLock.lockId, rgLock.lockId] }
  }

  /**
   * Release all locks held by a workflow.
   */
  async releaseAll(tenantId, workflowId) {
    const tc = lockTable()
    const toDelete = []
    for await (const entity of tc.listEntities({
      queryOptions: { filter: `PartitionKey eq '${tenantId}' and workflowId eq '${workflowId}'` }
    })) {
      toDelete.push(entity)
    }
    for (const entity of toDelete) {
      await tc.deleteEntity(entity.partitionKey, entity.rowKey).catch(() => {})
    }
    return toDelete.length
  }

  /**
   * Recover stale locks (called on startup).
   */
  async recoverStaleLocks(tenantId) {
    const tc = lockTable()
    const now = Date.now()
    let recovered = 0
    for await (const entity of tc.listEntities({
      queryOptions: { filter: `PartitionKey eq '${tenantId}'` }
    })) {
      if (entity.expiresAt && new Date(entity.expiresAt).getTime() < now) {
        await tc.deleteEntity(entity.partitionKey, entity.rowKey).catch(() => {})
        recovered++
      }
    }
    return recovered
  }

  _lockKey(resourceId) {
    return resourceId.replace(/[/\\#?%]/g, '_').slice(0, 200)
  }
}

module.exports = { WorkflowLockManager: new WorkflowLockManager() }
