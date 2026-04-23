// ============================================================
// FILE: services/alertService.js
// ROLE: Single source of truth for sending drift alert emails
//
// sendDriftAlertEmail(payload):
//   - If severity is 'critical' or 'high' → calls driftAlertRouter Function
//     which calls sendAlert Function → ACS email with Approve/Reject links
//   - If severity is 'low' or 'medium' → does nothing, returns immediately
//   - Fire-and-forget (non-blocking) — caller does not need to await
// ============================================================
'use strict'
const fetch = require('node-fetch')

// Only these severity levels trigger an email alert
const EMAIL_ALERT_SEVERITY_LEVELS = ['critical', 'high']

/**
 * Sends a drift alert email if severity warrants it.
 * @param {object} payload - The drift event payload { severity, resourceId, resourceGroup, subscriptionId, differences, detectedAt, ... }
 */
async function sendDriftAlertEmail(payload) {
  console.log('[sendDriftAlertEmail] starts — severity:', payload?.severity, '| resourceId:', payload?.resourceId)

  if (!payload?.severity) {
    console.log('[sendDriftAlertEmail] ends — no severity provided, skipping')
    return
  }

  if (!EMAIL_ALERT_SEVERITY_LEVELS.includes(payload.severity)) {
    // Low and medium severity do not trigger email alerts
    console.log('[sendDriftAlertEmail] ends — severity is', payload.severity, '— no email sent (only critical/high trigger emails)')
    return
  }

  const driftAlertRouterUrl = process.env.DRIFT_ALERT_ROUTER_URL
  if (!driftAlertRouterUrl) {
    console.log('[sendDriftAlertEmail] ends — DRIFT_ALERT_ROUTER_URL not configured, skipping')
    return
  }

  // Severity is critical or high — send the alert email
  console.log('[sendDriftAlertEmail] severity is', payload.severity, '— sending alert email via driftAlertRouter')

  try {
    const httpResponse = await fetch(driftAlertRouterUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    })
    const responseData = await httpResponse.json().catch(() => ({}))
    console.log('[sendDriftAlertEmail] ends — alerted:', responseData.alerted)
  } catch (fetchError) {
    // Non-fatal — email failure should never block the main remediation flow
    console.error('[sendDriftAlertEmail] ends — fetch error:', fetchError.message)
  }
}

module.exports = { sendDriftAlertEmail }
