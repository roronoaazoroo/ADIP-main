const { EmailClient } = require('@azure/communication-email')

const ALERT_LEVELS = ['critical', 'high']

module.exports = async function (context, req) {
  const record = req.body
  if (!record || !ALERT_LEVELS.includes(record.severity)) {
    context.res = { status: 200, body: { skipped: true } }
    return
  }

  const connStr    = process.env.COMMS_CONNECTION_STRING
  const recipients = (process.env.ALERT_RECIPIENT_EMAIL || '').split(',').map(e => e.trim()).filter(Boolean)
  if (!connStr || !recipients.length) {
    context.res = { status: 400, body: { error: 'COMMS_CONNECTION_STRING or ALERT_RECIPIENT_EMAIL not configured' } }
    return
  }

  const resourceName  = record.resourceId?.split('/').pop() ?? record.resourceId
  const severityLabel = record.severity.toUpperCase()
  const color         = record.severity === 'critical' ? '#dc2626' : '#d97706'
  const baseUrl       = process.env.EXPRESS_PUBLIC_URL || 'http://localhost:3001'
  const changes       = (record.differences || record.changes || []).slice(0, 10)

  const token = Buffer.from(JSON.stringify({
    resourceId:     record.resourceId,
    resourceGroup:  record.resourceGroup,
    subscriptionId: record.subscriptionId,
    detectedAt:     record.detectedAt,
  })).toString('base64url')

  const approveUrl = `${baseUrl}/api/remediate-decision?action=approve&token=${token}`
  const rejectUrl  = `${baseUrl}/api/remediate-decision?action=reject&token=${token}`

  const diffRows = changes.map(c => {
    const typeColor = { modified: '#d97706', added: '#16a34a', removed: '#dc2626' }
    const col = typeColor[c.type] || '#6b7280'
    return `<tr><td style="padding:6px 8px;font-family:monospace;font-size:12px">${c.path||''}</td><td style="padding:6px 8px;text-align:center"><span style="background:${col}22;color:${col};padding:2px 6px;border-radius:4px;font-size:11px;font-weight:700">${(c.type||'').toUpperCase()}</span></td><td style="padding:6px 8px;font-size:12px;color:#dc2626">${c.oldValue != null ? String(c.oldValue) : '—'}</td><td style="padding:6px 8px;font-size:12px;color:#16a34a">${c.newValue != null ? String(c.newValue) : '—'}</td></tr>`
  }).join('')

  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
  <div style="background:${color};padding:20px 24px"><h2 style="color:#fff;margin:0">Azure Drift Alert — ${severityLabel}</h2></div>
  <div style="padding:24px;background:#fff">
    <table style="width:100%;font-size:14px;border-collapse:collapse">
      <tr><td style="padding:6px 0;color:#6b7280;width:140px">Resource</td><td style="font-weight:600">${resourceName}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280">Resource Group</td><td>${record.resourceGroup}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280">Severity</td><td style="font-weight:700;color:${color}">${severityLabel}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280">Changes</td><td>${changes.length} field(s)</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280">Detected At</td><td>${new Date(record.detectedAt).toLocaleString()}</td></tr>
    </table>
    ${diffRows ? `<div style="margin-top:20px"><table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden"><thead><tr style="background:#f9fafb"><th style="padding:6px 8px;text-align:left;font-size:11px;color:#6b7280">Property</th><th style="padding:6px 8px;font-size:11px;color:#6b7280">Change</th><th style="padding:6px 8px;text-align:left;font-size:11px;color:#6b7280">Old</th><th style="padding:6px 8px;text-align:left;font-size:11px;color:#6b7280">New</th></tr></thead><tbody>${diffRows}</tbody></table></div>` : ''}
    <div style="margin-top:24px;padding:16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px">
      <p style="font-size:13px;font-weight:600;color:#166534;margin:0 0 12px">Action Required — Approve or Reject Remediation</p>
      <div style="display:flex;gap:12px">
        <a href="${approveUrl}" style="padding:10px 24px;background:#16a34a;color:#fff;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600">Approve Remediation</a>
        <a href="${rejectUrl}" style="padding:10px 24px;background:#6b7280;color:#fff;text-decoration:none;border-radius:6px;font-size:13px;font-weight:600">Reject</a>
      </div>
    </div>
  </div>
</div>`

  try {
    const client = new EmailClient(connStr)
    const poller = await client.beginSend({
      senderAddress: process.env.SENDER_ADDRESS,
      recipients:    { to: recipients.map(address => ({ address })) },
      content: {
        subject:   `[ADIP] ${severityLabel} Drift — ${resourceName} — Action Required`,
        html,
        plainText: `ADIP Drift Alert\nSeverity: ${severityLabel}\nResource: ${resourceName}\nChanges: ${changes.length}\nDetected: ${record.detectedAt}`,
      },
    })
    await poller.pollUntilDone()
    context.res = { status: 200, body: { sent: true } }
  } catch (err) {
    context.log.error('[sendAlert] email failed:', err.message)
    context.res = { status: 500, body: { error: err.message } }
  }
}
