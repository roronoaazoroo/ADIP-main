// ============================================================
// FILE: adip-backend/function-app/processSchedules/index.js
// ROLE: Azure Function Timer Trigger — replaces setInterval in app.js
//
// Runs every minute. Processes due remediation schedules:
//   - Executes schedules whose scheduledAt has passed
//   - Auto-approves after autoApprovalHours
//   - Escalates medium severity to high after 48h
// ============================================================
'use strict'
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') })
const { TableClient } = require('@azure/data-tables')
const fetch           = require('node-fetch')

const STATUS = { PENDING: 'pending', EXECUTED: 'executed', ESCALATED: 'escalated' }

function tableClient() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'remediationSchedules')
}

async function executeSchedule(entity) {
  const baseUrl = (process.env.EXPRESS_API_URL || 'http://localhost:3001').replace(/\/api$/, '')
  const resp = await fetch(`${baseUrl}/api/remediate`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      subscriptionId:  entity.partitionKey,
      resourceGroupId: entity.resourceGroupId,
      resourceId:      entity.resourceId,
    }),
  })
  const status = resp.ok ? STATUS.EXECUTED : 'failed'
  const errMsg = resp.ok ? null : await resp.text().catch(() => '')
  await tableClient().upsertEntity({
    ...entity,
    status,
    executedAt: new Date().toISOString(),
    ...(errMsg ? { failReason: errMsg } : {}),
  }, 'Replace').catch(() => {})
}

module.exports = async function (context) {
  context.log('[processSchedules] starts')
  const now = new Date()
  try {
    const pending = []
    for await (const entity of tableClient().listEntities({ queryOptions: { filter: `status eq '${STATUS.PENDING}'` } })) {
      pending.push(entity)
    }
    for (const entity of pending) {
      const scheduledAt       = new Date(entity.scheduledAt)
      const ageHours          = (now - new Date(entity.createdAt)) / 3600000
      const autoApprovalHours = entity.autoApprovalHours || 24

      if (now >= scheduledAt || ageHours >= autoApprovalHours) {
        await executeSchedule(entity)
      } else if (entity.severity === 'medium' && ageHours >= 48) {
        await tableClient().upsertEntity({ ...entity, severity: 'high', status: STATUS.ESCALATED }, 'Replace')
        context.log('[processSchedules] escalated medium→high:', entity.rowKey)
      }
    }
  } catch (err) {
    context.log.error('[processSchedules] error:', err.message)
  }
  context.log('[processSchedules] ends')
}
