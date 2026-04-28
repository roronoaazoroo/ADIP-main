// ============================================================
// FILE: adip-backend/express-api/src/routes/suppressionRules.js
// ROLE: CRUD endpoints for drift suppression rules
//
// GET    /api/suppression-rules?subscriptionId=   — list all rules
// POST   /api/suppression-rules                   — create a rule
// DELETE /api/suppression-rules/:rowKey           — delete a rule
//
// Rules are stored in Azure Table Storage (suppressionRules table).
// PartitionKey = subscriptionId, RowKey = nanoid-style timestamp key
// ============================================================
'use strict'
const router = require('express').Router()
const { TableClient } = require('@azure/data-tables')

function tableClient() {
  return TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'suppressionRules')
}

// GET /api/suppression-rules?subscriptionId=
router.get('/suppression-rules', async (req, res) => {
  console.log('[GET /suppression-rules] starts')
  const { subscriptionId } = req.query
  if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' })

  try {
    const rules = []
    const filter = `PartitionKey eq '${subscriptionId}'`
    for await (const entity of tableClient().listEntities({ queryOptions: { filter } })) {
      rules.push({
        rowKey:          entity.rowKey,
        fieldPath:       entity.fieldPath,
        resourceGroupId: entity.resourceGroupId || '',
        resourceId:      entity.resourceId      || '',
        changeTypes:     entity.changeTypes ? entity.changeTypes.split(',').filter(Boolean) : [],
        reason:          entity.reason || '',
        createdAt:       entity.createdAt,
      })
    }
    res.json(rules)
    console.log('[GET /suppression-rules] ends — count:', rules.length)
  } catch (err) {
    console.log('[GET /suppression-rules] error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/suppression-rules
// Body: { subscriptionId, fieldPath, resourceGroupId?, resourceId?, changeTypes?, reason? }
router.post('/suppression-rules', async (req, res) => {
  console.log('[POST /suppression-rules] starts')
  const { subscriptionId, fieldPath, resourceGroupId = '', resourceId = '', changeTypes = [], reason = '' } = req.body

  if (!subscriptionId || !fieldPath) {
    return res.status(400).json({ error: 'subscriptionId and fieldPath required' })
  }
  if (subscriptionId.includes("'") || fieldPath.length > 256) {
    return res.status(400).json({ error: 'Invalid input' })
  }

  try {
    const rowKey = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await tableClient().upsertEntity({
      partitionKey:    subscriptionId,
      rowKey,
      fieldPath,
      resourceGroupId,
      resourceId,
      changeTypes:     Array.isArray(changeTypes) ? changeTypes.join(',') : changeTypes,
      reason,
      createdAt:       new Date().toISOString(),
    }, 'Replace')

    res.status(201).json({ rowKey, fieldPath, resourceGroupId, resourceId, changeTypes, reason })
    console.log('[POST /suppression-rules] ends — rowKey:', rowKey)
  } catch (err) {
    console.log('[POST /suppression-rules] error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/suppression-rules/:rowKey?subscriptionId=
router.delete('/suppression-rules/:rowKey', async (req, res) => {
  console.log('[DELETE /suppression-rules] starts')
  const { subscriptionId } = req.query
  const { rowKey } = req.params

  if (!subscriptionId || !rowKey) {
    return res.status(400).json({ error: 'subscriptionId and rowKey required' })
  }

  try {
    await tableClient().deleteEntity(subscriptionId, rowKey)
    res.json({ deleted: true, rowKey })
    console.log('[DELETE /suppression-rules] ends — rowKey:', rowKey)
  } catch (err) {
    console.log('[DELETE /suppression-rules] error:', err.message)
    res.status(404).json({ error: 'Rule not found' })
  }
})

module.exports = router
