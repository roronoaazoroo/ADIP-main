// ============================================================
// FILE: adip-backend/express-api/src/services/remediationScheduleService.js
// ROLE: Business logic for scheduled remediation
//
// Responsibilities:
//   - createSchedule()    — persist a scheduled remediation to Table Storage
//   - listSchedules()     — list all schedules for a subscription
//   - processDueSchedules() — called every 60s by the poller in app.js
//       • Executes remediation for schedules whose scheduledAt has passed
//       • Auto-approves schedules where autoApprovalHours has elapsed since creation
//       • Escalates medium-severity drift to high after 48h unresolved
// ============================================================
'use strict'
const { TableClient }       = require('@azure/data-tables')
const { sendDriftAlertEmail } = require('./alertService')

const TABLE = 'remediationSchedules'

function tableClient() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, TABLE)
}

// Status values
const STATUS = { PENDING: 'pending', EXECUTED: 'executed', ESCALATED: 'escalated', CANCELLED: 'cancelled' }

/**
 * Creates a scheduled remediation entry in Table Storage.
 * @param {object} params
 * @returns {object} created schedule entity
 */
async function createSchedule({ subscriptionId, resourceGroupId, resourceId, severity, scheduledAt, autoApprovalHours = 24 }) {
  console.log('[createSchedule] starts — resourceId:', resourceId, 'scheduledAt:', scheduledAt)
  const rowKey = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const entity = {
    partitionKey:      subscriptionId,
    rowKey,
    resourceGroupId,
    resourceId,
    severity,
    scheduledAt,
    autoApprovalHours: Number(autoApprovalHours),
    status:            STATUS.PENDING,
    createdAt:         new Date().toISOString(),
  }
  await tableClient().upsertEntity(entity, 'Replace')
  console.log('[createSchedule] ends — rowKey:', rowKey)
  return { rowKey, ...entity }
}

/**
 * Lists all schedules for a subscription.
 */
async function listSchedules(subscriptionId) {
  console.log('[listSchedules] starts — subscriptionId:', subscriptionId)
  const schedules = []
  const filter = `PartitionKey eq '${subscriptionId}'`
  for await (const entity of tableClient().listEntities({ queryOptions: { filter } })) {
    schedules.push({
      rowKey:            entity.rowKey,
      resourceId:        entity.resourceId,
      resourceGroupId:   entity.resourceGroupId,
      severity:          entity.severity,
      scheduledAt:       entity.scheduledAt,
      autoApprovalHours: entity.autoApprovalHours,
      status:            entity.status,
      createdAt:         entity.createdAt,
      executedAt:        entity.executedAt,
    })
  }
  console.log('[listSchedules] ends — count:', schedules.length)
  return schedules.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
}

/**
 * Cancels a schedule by rowKey.
 */
async function cancelSchedule(subscriptionId, rowKey) {
  const entity = await tableClient().getEntity(subscriptionId, rowKey)
  await tableClient().upsertEntity({ ...entity, status: STATUS.CANCELLED }, 'Replace')
}

/**
 * Executes a pending schedule by calling the existing /api/remediate endpoint.
 */
async function executeSchedule(entity) {
  console.log('[executeSchedule] starts — rowKey:', entity.rowKey, 'resourceId:', entity.resourceId)
  try {
    const fetch = require('node-fetch')
    const baseUrl = process.env.EXPRESS_API_URL || 'http://localhost:3001'
    const apiUrl  = baseUrl.endsWith('/api') ? baseUrl : `${baseUrl}/api`
    const resp = await fetch(`${apiUrl}/remediate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        subscriptionId:  entity.partitionKey,
        resourceGroupId: entity.resourceGroupId,
        resourceId:      entity.resourceId,
      }),
    })
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '')
      throw new Error(`Remediate returned ${resp.status}: ${errBody}`)
    }
    await tableClient().upsertEntity({
      ...entity,
      status:     STATUS.EXECUTED,
      executedAt: new Date().toISOString(),
    }, 'Replace')
    console.log('[executeSchedule] ends — executed')
  } catch (err) {
    console.log('[executeSchedule] ends — error:', err.message)
    await tableClient().upsertEntity({
      ...entity,
      status:     'failed',
      failedAt:   new Date().toISOString(),
      failReason: err.message,
    }, 'Replace').catch(() => {})
  }
}

/**
 * Main poller function — called every 60 seconds from app.js.
 * Processes all pending schedules across all subscriptions.
 */
async function processDueSchedules() {
  const now = new Date()
  console.log('[processDueSchedules] starts —', now.toISOString())

  try {
    const pending = []
    for await (const entity of tableClient().listEntities({
      queryOptions: { filter: `status eq '${STATUS.PENDING}'` }
    })) {
      pending.push(entity)
    }

    for (const entity of pending) {
      const scheduledAt  = new Date(entity.scheduledAt)
      const createdAt    = new Date(entity.createdAt)
      const ageHours     = (now - createdAt) / 3600000
      const autoApprovalHours = entity.autoApprovalHours || 24

      // Execute if scheduled time has passed
      if (now >= scheduledAt) {
        await executeSchedule(entity)
        continue
      }

      // Auto-approve: if admin hasn't cancelled within autoApprovalHours, execute now
      if (ageHours >= autoApprovalHours) {
        console.log('[processDueSchedules] auto-approving rowKey:', entity.rowKey)
        await executeSchedule(entity)
        continue
      }

      // Escalate medium severity to high after 48h unresolved
      if (entity.severity === 'medium' && ageHours >= 48 && entity.status !== STATUS.ESCALATED) {
        console.log('[processDueSchedules] escalating medium→high rowKey:', entity.rowKey)
        await tableClient().upsertEntity({ ...entity, severity: 'high', status: STATUS.ESCALATED }, 'Replace')
        // Send escalation alert
        await sendDriftAlertEmail({
          severity:      'high',
          resourceId:    entity.resourceId,
          resourceGroup: entity.resourceGroupId,
          subscriptionId: entity.partitionKey,
          detectedAt:    entity.createdAt,
          differences:   [],
          reportSummary: `Scheduled remediation for ${entity.resourceId.split('/').pop()} has been unresolved for 48h. Severity escalated from medium to high.`,
          isReport:      true,
        }).catch(emailErr => console.log('[processDueSchedules] escalation email failed:', emailErr.message))
      }
    }
  } catch (err) {
    console.log('[processDueSchedules] error:', err.message)
  }

  console.log('[processDueSchedules] ends')
}

module.exports = { createSchedule, listSchedules, cancelSchedule, processDueSchedules }
