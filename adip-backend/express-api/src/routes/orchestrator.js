// ============================================================
// routes/orchestrator.js — API endpoints for the agentic orchestrator
// ============================================================
'use strict'
const router = require('express').Router()
const { EventRouter, WorkflowStateManager, AuditLogger, MemoryStore, CostMonitor, breakers } = require('../orchestrator')

// POST /api/orchestrator/event — Submit event for autonomous processing
router.post('/orchestrator/event', async (req, res) => {
  try {
    const event = { ...req.body, tenantId: req.body.tenantId || 'default' }
    const result = await EventRouter.process(event)
    res.status(result.status === 'accepted' ? 202 : 200).json(result)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// POST /api/orchestrator/workflow/:id/resume — Resume after approval
router.post('/orchestrator/workflow/:id/resume', async (req, res) => {
  try {
    const tenantId = req.body.tenantId || 'default'
    const result = await EventRouter.resume(tenantId, req.params.id, req.body.event || 'approved', req.body)
    res.json(result)
  } catch (error) {
    res.status(400).json({ error: error.message })
  }
})

// POST /api/orchestrator/workflow/:id/override — Human override
router.post('/orchestrator/workflow/:id/override', async (req, res) => {
  try {
    const { tenantId = 'default', action, reason } = req.body
    const actor = req.user?.email || req.body.actor || 'unknown'
    const result = await EventRouter.override(tenantId, req.params.id, action, actor, reason || '')
    res.json(result)
  } catch (error) {
    res.status(400).json({ error: error.message })
  }
})

// GET /api/orchestrator/workflow/:id — Get workflow status + steps + audit
router.get('/orchestrator/workflow/:id', async (req, res) => {
  try {
    const tenantId = req.query.tenantId || 'default'
    const workflow = await WorkflowStateManager.get(tenantId, req.params.id)
    if (!workflow) return res.status(404).json({ error: 'Workflow not found' })
    const steps = await WorkflowStateManager.getSteps(tenantId, req.params.id)
    const audit = await AuditLogger.getTrail(tenantId, req.params.id)
    res.json({ ...workflow, steps, audit: audit.slice(-30) })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// GET /api/orchestrator/workflows — List workflows for tenant
router.get('/orchestrator/workflows', async (req, res) => {
  try {
    const tenantId = req.query.tenantId || 'default'
    const { TableClient } = require('@azure/data-tables')
    const tc = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'orchestratorWorkflows')
    const results = []
    for await (const entity of tc.listEntities({ queryOptions: { filter: `PartitionKey eq '${tenantId}'` } })) {
      results.push({ workflowId: entity.rowKey, status: entity.status, eventType: entity.eventType, severity: entity.severity, resourceId: entity.resourceId, createdAt: entity.createdAt, completedAt: entity.completedAt, stepsCompleted: entity.stepsCompleted, stepsTotal: entity.stepsTotal })
    }
    results.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    res.json(results.slice(0, 50))
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// GET /api/orchestrator/memory — Agent memory/stats
router.get('/orchestrator/memory', async (req, res) => {
  try {
    const tenantId = req.query.tenantId || 'default'
    const stats = await MemoryStore.getStats(tenantId)
    res.json(stats)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// GET /api/orchestrator/health — Circuit breakers + cost stats
router.get('/orchestrator/health', (req, res) => {
  res.json({
    circuitBreakers: Object.fromEntries(Object.entries(breakers).map(([k, v]) => [k, v.getState()])),
    cost: CostMonitor.getStats(),
  })
})

module.exports = router
