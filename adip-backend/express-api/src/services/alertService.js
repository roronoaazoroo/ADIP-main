const { EmailClient } = require('@azure/communication-email')

const ALERT_LEVELS = ['critical', 'high']
let emailClient = null

function getEmailClient() {
  if (!emailClient && process.env.COMMS_CONNECTION_STRING) {
    emailClient = new EmailClient(process.env.COMMS_CONNECTION_STRING)
  }
  return emailClient
}

async function sendDriftAlert(record) {
  const recipients = (process.env.ALERT_RECIPIENT_EMAIL || '')
    .split(',').map(e => e.trim()).filter(Boolean)
  if (!recipients.length || !ALERT_LEVELS.includes(record.severity)) return

  const client = getEmailClient()
  if (!client) return

  const resourceName   = record.resourceId?.split('/').pop() ?? record.resourceId
  const severityColor  = record.severity === 'critical' ? '#dc2626' : '#d97706'
  const severityLabel  = record.severity.toUpperCase()

  const htmlBody = `
    <div style="font-family:Segoe UI,Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
      <div style="background:${severityColor};padding:20px 24px">
        <h2 style="color:#fff;margin:0;font-size:20px">🚨 Azure Drift Alert — ${severityLabel}</h2>
      </div>
      <div style="padding:24px;background:#fff">
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <tr style="border-bottom:1px solid #f3f4f6">
            <td style="padding:10px 0;color:#6b7280;width:140px">Resource</td>
            <td style="padding:10px 0;font-weight:600;color:#111827">${resourceName}</td>
          </tr>
          <tr style="border-bottom:1px solid #f3f4f6">
            <td style="padding:10px 0;color:#6b7280">Resource Group</td>
            <td style="padding:10px 0;color:#111827">${record.resourceGroup}</td>
          </tr>
          <tr style="border-bottom:1px solid #f3f4f6">
            <td style="padding:10px 0;color:#6b7280">Severity</td>
            <td style="padding:10px 0;font-weight:700;color:${severityColor}">${severityLabel}</td>
          </tr>
          <tr style="border-bottom:1px solid #f3f4f6">
            <td style="padding:10px 0;color:#6b7280">Changes Detected</td>
            <td style="padding:10px 0;color:#111827">${record.changeCount} field(s)</td>
          </tr>
          <tr style="border-bottom:1px solid #f3f4f6">
            <td style="padding:10px 0;color:#6b7280">Subscription</td>
            <td style="padding:10px 0;color:#111827">${record.subscriptionId}</td>
          </tr>
          <tr>
            <td style="padding:10px 0;color:#6b7280">Detected At</td>
            <td style="padding:10px 0;color:#111827">${new Date(record.detectedAt).toLocaleString()}</td>
          </tr>
        </table>
        <div style="margin-top:20px;padding:16px;background:#f9fafb;border-radius:6px;font-size:13px;color:#374151">
          <strong>Action Required:</strong> Log in to the ADIP Dashboard to review the drift and remediate if necessary.
        </div>
      </div>
      <div style="padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af">
        Azure Drift Intelligence Platform — Automated Alert
      </div>
    </div>`

  try {
    const poller = await client.beginSend({
      senderAddress: process.env.SENDER_ADDRESS,
      recipients:    { to: recipients.map(address => ({ address })) },
      content: {
        subject:   `[ADIP] ${severityLabel} Drift Detected — ${resourceName}`,
        html:      htmlBody,
        plainText: `ADIP Drift Alert\nSeverity: ${severityLabel}\nResource: ${resourceName}\nResource Group: ${record.resourceGroup}\nChanges: ${record.changeCount}\nDetected: ${record.detectedAt}`,
      },
    })
    await poller.pollUntilDone()
    console.log(`[Alert] Email sent to ${recipients.join(', ')} for ${severityLabel} drift on ${resourceName}`)
  } catch (err) {
    console.error('[Alert] Email send failed:', err.message)
  }
}

module.exports = { sendDriftAlert }
