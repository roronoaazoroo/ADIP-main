// FILE: adip-backend/express-api/src/routes/remediationSchedule.js
// ROLE: HTTP endpoints for scheduled remediation

// POST   /api/remediation-schedule          — create a schedule
// GET    /api/remediation-schedule?subscriptionId= — list schedules
// DELETE /api/remediation-schedule/:rowKey?subscriptionId= — cancel

'use strict'
const router = require('express').Router()
const { createSchedule, listSchedules, cancelSchedule } = require('../services/remediationScheduleService')
const { EmailClient } = require('@azure/communication-email')

const HIGH_SEVERITY = ['high', 'critical']

// Sends an approval email for high/critical scheduled remediations
async function sendScheduleApprovalEmail(schedule) {
  const connStr   = process.env.COMMS_CONNECTION_STRING
  const sender    = process.env.SENDER_ADDRESS
  const recipient = process.env.ALERT_RECIPIENT_EMAIL
  if (!connStr || !sender || !recipient) return

  const resourceName  = schedule.resourceId?.split('/').pop() || schedule.resourceId
  const scheduledTime = new Date(schedule.scheduledAt).toLocaleString()
  const cancelUrl = `${process.env.EXPRESS_PUBLIC_URL || process.env.EXPRESS_API_URL || 'http://localhost:3001'}/api/remediation-schedule/${encodeURIComponent(schedule.rowKey)}/cancel?subscriptionId=${encodeURIComponent(schedule.partitionKey)}`

  const client = new EmailClient(connStr)
  // Fire-and-forget — don't await pollUntilDone() to avoid blocking the API response
  client.beginSend({
    senderAddress: sender,
    recipients:    { to: [{ address: recipient }] },
    content: {
      subject:   `[ADIP] Scheduled Remediation Approval Required — ${resourceName} (${schedule.severity?.toUpperCase()})`,
      html: `
        <h2>Scheduled Remediation Requires Approval</h2>
        <p>A <strong>${schedule.severity}</strong> severity remediation has been scheduled for:</p>
        <ul>
          <li><strong>Resource:</strong> ${resourceName}</li>
          <li><strong>Resource Group:</strong> ${schedule.resourceGroupId}</li>
          <li><strong>Scheduled Time:</strong> ${scheduledTime}</li>
          <li><strong>Auto-approval after:</strong> ${schedule.autoApprovalHours || 24} hours</li>
        </ul>
        <p>The fix will be applied automatically at the scheduled time unless cancelled.</p>
        <p><a href="${cancelUrl}" style="background:#dc2626;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Cancel Schedule</a></p>
      `,
      plainText: `Scheduled remediation for ${resourceName} at ${scheduledTime}. Auto-approves after ${schedule.autoApprovalHours || 24}h.`,
    },
  }).then(poller => poller.pollUntilDone())
    .then(() => console.log('[sendScheduleApprovalEmail] sent for rowKey:', schedule.rowKey))
    .catch(err => console.log('[sendScheduleApprovalEmail] failed:', err.message))
}

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

    // Send approval email for high/critical severity schedules
    if (HIGH_SEVERITY.includes((severity || '').toLowerCase())) {
      sendScheduleApprovalEmail({ ...schedule, partitionKey: subscriptionId })
        .then(() => console.log('[POST /remediation-schedule] approval email sent'))
        .catch(emailErr => console.log('[POST /remediation-schedule] approval email FAILED:', emailErr.message, emailErr.stack?.split('\n')[1]))
    }

    res.status(201).json(schedule)
    console.log('[POST /remediation-schedule] ends — rowKey:', schedule.rowKey, 'emailSent:', HIGH_SEVERITY.includes((severity || '').toLowerCase()))
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

// GET /api/remediation-schedule/:rowKey/cancel?subscriptionId= — cancel via email link click
router.get('/remediation-schedule/:rowKey/cancel', async (req, res) => {
  console.log('[GET /remediation-schedule/cancel] starts')
  const { subscriptionId } = req.query
  const { rowKey } = req.params
  if (!subscriptionId || !rowKey) return res.status(400).send('Missing subscriptionId or rowKey')
  try {
    await cancelSchedule(subscriptionId, rowKey)
    res.send(`<html><body style="font-family:sans-serif;max-width:500px;margin:60px auto;text-align:center">
      <h2 style="color:#16a34a">✓ Schedule Cancelled</h2>
      <p>The remediation schedule has been cancelled successfully.</p>
    </body></html>`)
    console.log('[GET /remediation-schedule/cancel] ends — rowKey:', rowKey)
  } catch (err) {
    res.status(404).send(`<html><body style="font-family:sans-serif;max-width:500px;margin:60px auto;text-align:center">
      <h2 style="color:#dc2626">Schedule Not Found</h2>
      <p>${err.message}</p>
    </body></html>`)
  }
})

module.exports = router
