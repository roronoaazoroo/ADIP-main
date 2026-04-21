// FILE: adip-backend/function-app/sendAlert/index.js
// ROLE: Azure Function — builds and sends an HTML drift alert email via ACS

// Trigger: HTTP POST from adip-drift-alert Logic App
//   (Logic App is called by Express remediateRequest.js for medium/high/critical drift)

// What this function does:
//   1. Receives the drift record from the Logic App
//   2. Skips if severity is not critical or high
//   3. Builds an HTML email with a diff table showing old → new values
//   4. Generates a base64url token encoding the resource identifiers
//   5. Embeds Approve/Reject links pointing to EXPRESS_PUBLIC_URL/api/remediate-decision
//   6. Sends via Azure Communication Services EmailClient

// approveUrl / rejectUrl: when the admin clicks these in their email,
//   the browser hits Express /api/remediate-decision which decodes the token
//   and either ARM PUTs the baseline back (approve) or saves live as new baseline (reject)

const { EmailClient } = require('@azure/communication-email')

// Only send alerts for these severity levels — medium/low are handled differently
const ALERT_SEVERITY_LEVELS = ['critical', 'high']

module.exports = async function (context, req) {
  const driftRecord = req.body
  if (!driftRecord || !ALERT_SEVERITY_LEVELS.includes(driftRecord.severity)) {
    context.res = { status: 200, body: { skipped: true } }
    return
  }

  const acsConnectionString = process.env.COMMS_CONNECTION_STRING
  // Parse comma-separated recipient list from env (e.g. 'admin@co.com,ops@co.com')
  const recipientEmailList  = (process.env.ALERT_RECIPIENT_EMAIL || '').split(',').map(addr => addr.trim()).filter(Boolean)
  if (!acsConnectionString || !recipientEmailList.length) {
    context.res = { status: 400, body: { error: 'COMMS_CONNECTION_STRING or ALERT_RECIPIENT_EMAIL not configured' } }
    return
  }

  // Extract display values from the drift record
  const resourceShortName = driftRecord.resourceId?.split('/').pop() ?? driftRecord.resourceId
  const severityLabel     = driftRecord.severity.toUpperCase()
  const severityColor     = driftRecord.severity === 'critical' ? '#dc2626' : '#d97706'
  const expressPublicUrl  = process.env.EXPRESS_PUBLIC_URL || 'http://localhost:3001'
  // Limit to 10 changes to keep the email readable
  const changesForEmail   = (driftRecord.differences || driftRecord.changes || []).slice(0, 10)

  // Build the remediation token — base64url-encoded JSON with resource identifiers
  // This token is decoded by /api/remediate-decision when the admin clicks Approve/Reject
  const remediationToken = Buffer.from(JSON.stringify({
    resourceId:     driftRecord.resourceId,
    resourceGroup:  driftRecord.resourceGroup,
    subscriptionId: driftRecord.subscriptionId,
    detectedAt:     driftRecord.detectedAt,
  })).toString('base64url')

  const approveUrl = `${expressPublicUrl}/api/remediate-decision?action=approve&token=${remediationToken}`
  const rejectUrl  = `${expressPublicUrl}/api/remediate-decision?action=reject&token=${remediationToken}`

  // Build HTML table rows for each changed field
  const changeTypeColors = { modified: '#d97706', added: '#16a34a', removed: '#dc2626' }
  const emailDiffTableRows = changesForEmail.map(changeItem => {
    const changeColor = changeTypeColors[changeItem.type] || '#6b7280'
    return `<tr><td style="padding:6px 8px;font-family:monospace;font-size:12px">${changeItem.path||''}</td><td style="padding:6px 8px;text-align:center"><span style="background:${changeColor}22;color:${changeColor};padding:2px 6px;border-radius:4px;font-size:11px;font-weight:700">${(changeItem.type||'').toUpperCase()}</span></td><td style="padding:6px 8px;font-size:12px;color:#dc2626">${changeItem.oldValue != null ? String(changeItem.oldValue) : '—'}</td><td style="padding:6px 8px;font-size:12px;color:#16a34a">${changeItem.newValue != null ? String(changeItem.newValue) : '—'}</td></tr>`
  }).join('')

  const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:640px;margin:0 auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
  <div style="background:${severityColor};padding:20px 24px"><h2 style="color:#fff;margin:0">Azure Drift Alert — ${severityLabel}</h2></div>
  <div style="padding:24px;background:#fff">
    <table style="width:100%;font-size:14px;border-collapse:collapse">
      <tr><td style="padding:6px 0;color:#6b7280;width:140px">Resource</td><td style="font-weight:600">${resourceShortName}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280">Resource Group</td><td>${driftRecord.resourceGroup}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280">Severity</td><td style="font-weight:700;color:${severityColor}">${severityLabel}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280">Changes</td><td>${changesForEmail.length} field(s)</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280">Detected At</td><td>${new Date(driftRecord.detectedAt).toLocaleString()}</td></tr>
    </table>
    ${emailDiffTableRows ? `<div style="margin-top:20px"><table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden"><thead><tr style="background:#f9fafb"><th style="padding:6px 8px;text-align:left;font-size:11px;color:#6b7280">Property</th><th style="padding:6px 8px;font-size:11px;color:#6b7280">Change</th><th style="padding:6px 8px;text-align:left;font-size:11px;color:#6b7280">Old</th><th style="padding:6px 8px;text-align:left;font-size:11px;color:#6b7280">New</th></tr></thead><tbody>${emailDiffTableRows}</tbody></table></div>` : ''}
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
    const acsEmailClient  = new EmailClient(acsConnectionString)
    const emailSendPoller = await acsEmailClient.beginSend({
      senderAddress: process.env.SENDER_ADDRESS,
      recipients:    { to: recipientEmailList.map(emailAddress => ({ address: emailAddress })) },
      content: {
        subject:   `[ADIP] ${severityLabel} Drift — ${resourceShortName} — Action Required`,
        html,
        plainText: `ADIP Drift Alert\nSeverity: ${severityLabel}\nResource: ${resourceShortName}\nChanges: ${changesForEmail.length}\nDetected: ${driftRecord.detectedAt}`,
      },
    })
    await emailSendPoller.pollUntilDone()
    context.res = { status: 200, body: { sent: true } }
  } catch (err) {
    context.log.error('[sendAlert] email failed:', err.message)
    context.res = { status: 500, body: { error: err.message } }
  }
}
