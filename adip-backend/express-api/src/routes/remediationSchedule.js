// ============================================================
// FILE: adip-backend/express-api/src/routes/remediationSchedule.js
// ROLE: HTTP endpoints for scheduled remediation
//
// POST   /api/remediation-schedule          — create a schedule
// GET    /api/remediation-schedule?subscriptionId= — list schedules
// DELETE /api/remediation-schedule/:rowKey?subscriptionId= — cancel
// ============================================================
'use strict'
const router = require('express').Router()
const { createSchedule, listSchedules, cancelSchedule } = require('../services/remediationScheduleService')

// POST /api/remediation-schedule
router.post('/remediation-schedule', async (req, res) => {
  console.log('[POST /remediation-schedule] starts')
  const { subscriptionId, resourceGroupId, resourceId, severity, scheduledAt, autoApprovalHours } = req.body

  if (!subscriptionId || !resourceGroupId || !resourceId || !scheduledAt) {
    return res.status(400).json({ error: 'subscriptionId, resourceGroupId, resourceId, scheduledAt required' })
  }
  if (new Date(scheduledAt) <= new Date()) {
    return res.status(400).json({ error: 'scheduledAt must be in the future' })
  }

  try {
    const schedule = await createSchedule({ subscriptionId, resourceGroupId, resourceId, severity, scheduledAt, autoApprovalHours })
    res.status(201).json(schedule)
    console.log('[POST /remediation-schedule] ends — rowKey:', schedule.rowKey)
  } catch (err) {
    console.log('[POST /remediation-schedule] error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/remediation-schedule?subscriptionId=
router.get('/remediation-schedule', async (req, res) => {
  console.log('[GET /remediation-schedule] starts')
  const { subscriptionId } = req.query
  if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' })

  try {
    const schedules = await listSchedules(subscriptionId)
    res.json(schedules)
    console.log('[GET /remediation-schedule] ends — count:', schedules.length)
  } catch (err) {
    console.log('[GET /remediation-schedule] error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/remediation-schedule/:rowKey?subscriptionId=
router.delete('/remediation-schedule/:rowKey', async (req, res) => {
  console.log('[DELETE /remediation-schedule] starts')
  const { subscriptionId } = req.query
  const { rowKey } = req.params
  if (!subscriptionId || !rowKey) return res.status(400).json({ error: 'subscriptionId and rowKey required' })

  try {
    await cancelSchedule(subscriptionId, rowKey)
    res.json({ cancelled: true, rowKey })
    console.log('[DELETE /remediation-schedule] ends — rowKey:', rowKey)
  } catch (err) {
    console.log('[DELETE /remediation-schedule] error:', err.message)
    res.status(404).json({ error: 'Schedule not found' })
  }
})

module.exports = router
