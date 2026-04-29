// ============================================================
// FILE: adip-backend/function-app/afterHoursAlert/index.js
// ROLE: Azure Function Timer Trigger — replaces setInterval in app.js
//
// Fires daily at 19:00. Sends a summary alert if critical drift
// events were detected today and not yet remediated.
// ============================================================
'use strict'
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') })
const { TableClient }  = require('@azure/data-tables')
const { EmailClient }  = require('@azure/communication-email')

module.exports = async function (context) {
  context.log('[afterHoursAlert] starts')
  try {
    const todayISO = new Date(Date.now() - 86400000).toISOString()
    const filter   = `PartitionKey eq '${process.env.AZURE_SUBSCRIPTION_ID}' and Timestamp ge datetime'${todayISO}' and severity eq 'critical'`
    const tc       = TableClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING, 'driftIndex')

    const criticalEvents = []
    for await (const entity of tc.listEntities({ queryOptions: { filter } })) {
      criticalEvents.push(entity)
    }

    if (!criticalEvents.length) {
      context.log('[afterHoursAlert] no critical drift today, skipping')
      return
    }

    const recipient = process.env.ALERT_RECIPIENT_EMAIL
    const sender    = process.env.SENDER_ADDRESS
    const connStr   = process.env.COMMS_CONNECTION_STRING
    if (!recipient || !sender || !connStr) {
      context.log('[afterHoursAlert] email not configured, skipping')
      return
    }

    const resourceList = criticalEvents.map(e => `<li>${e.resourceId?.split('/').pop()} — ${e.changeCount} change(s)</li>`).join('')
    const client = new EmailClient(connStr)
    const poller = await client.beginSend({
      senderAddress: sender,
      recipients:    { to: [{ address: recipient }] },
      content: {
        subject:   `[ADIP] After-Hours Alert — ${criticalEvents.length} critical drift event(s) today`,
        html:      `<h2>ADIP After-Hours Drift Summary</h2><p>${criticalEvents.length} critical drift event(s) detected today:</p><ul>${resourceList}</ul><p>Log in to ADIP to review and remediate.</p>`,
        plainText: `${criticalEvents.length} critical drift events detected today. Log in to ADIP to review.`,
      },
    })
    await poller.pollUntilDone()
    context.log('[afterHoursAlert] alert sent — critical events:', criticalEvents.length)
  } catch (err) {
    context.log.error('[afterHoursAlert] error:', err.message)
  }
  context.log('[afterHoursAlert] ends')
}
