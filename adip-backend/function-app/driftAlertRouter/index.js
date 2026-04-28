// ============================================================
// FILE: adip-backend/function-app/driftAlertRouter/index.js
// ROLE: Azure Function — replaces adip-drift-alert Logic App
//
// Trigger: HTTP POST from Express API
//   Called by: remediateRequest.js, remediate.js, app.js (after-hours check)
//
// What this function does:
//   1. Receives a drift event payload from Express
//   2. Checks if severity is 'critical' or 'high'
//      — if not, returns { alerted: false } immediately (no email sent)
//   3. If severity passes: calls the sendAlert Azure Function
//      which builds the HTML email and sends it via Azure Communication Services
//   4. Returns { alerted: true } on success
//
// Replaces: adip-drift-alert Logic App
// Called by: Express API (remediateRequest.js, remediate.js, app.js)
// Calls: sendAlert Azure Function
// ============================================================
'use strict'
'use strict'
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') })
const fetch = require('node-fetch')

// Severity levels that trigger an alert email — low and medium are handled differently
const ALERT_SEVERITY_LEVELS = ['critical', 'high']

// URL of the sendAlert Function — read from env so it works in any environment
// SEND_ALERT_FUNCTION_URL must be set — no hardcoded fallback
const SEND_ALERT_FUNCTION_URL = process.env.SEND_ALERT_FUNCTION_URL

// Function key for sendAlert (required because sendAlert has authLevel: function)
const SEND_ALERT_FUNCTION_KEY = process.env.SEND_ALERT_FUNCTION_KEY || ''

module.exports = async function (context, req) {
  console.log('[driftAlertRouter] starts')

  const driftEventPayload = req.body

  if (!driftEventPayload || typeof driftEventPayload !== 'object') {
    console.log('[driftAlertRouter] ends — invalid or missing payload')
    context.res = { status: 400, body: { error: 'Request body must be a JSON object' } }
    return
  }
  if (!SEND_ALERT_FUNCTION_URL) {
    context.log.error('[driftAlertRouter] SEND_ALERT_FUNCTION_URL not configured')
    context.res = { status: 500, body: { error: 'SEND_ALERT_FUNCTION_URL not configured' } }
    return
  }

  const incomingSeverity = driftEventPayload.severity || ''
  console.log('[driftAlertRouter] received severity:', incomingSeverity, '| resourceId:', driftEventPayload.resourceId)

  // ── Severity filter ───────────────────────────────────────────────────────
  // Only send alert emails for critical and high severity.
  // Low and medium are either auto-remediated or handled without email approval.
  if (!ALERT_SEVERITY_LEVELS.includes(incomingSeverity)) {
    console.log('[driftAlertRouter] severity not in alert levels — skipping email')
    context.res = { status: 200, body: { alerted: false, reason: `severity '${incomingSeverity}' does not require email alert` } }
    console.log('[driftAlertRouter] ends — skipped')
    return
  }

  // ── Call sendAlert Function ───────────────────────────────────────────────
  // sendAlert builds the HTML email with a diff table and Approve/Reject links,
  // then sends it via Azure Communication Services
  console.log('[driftAlertRouter] calling sendAlert Function for severity:', incomingSeverity)

  const sendAlertUrl = SEND_ALERT_FUNCTION_KEY
    ? `${SEND_ALERT_FUNCTION_URL}?code=${SEND_ALERT_FUNCTION_KEY}`
    : SEND_ALERT_FUNCTION_URL

  try {
    const sendAlertResponse = await fetch(sendAlertUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(driftEventPayload),
    })

    if (!sendAlertResponse.ok) {
      const errorBody = await sendAlertResponse.text().catch(() => '')
      context.log.error('[driftAlertRouter] sendAlert returned error:', sendAlertResponse.status, errorBody)
    }
    if (!sendAlertResponse.ok) {
      context.log.error('[driftAlertRouter] sendAlert returned error:', sendAlertResponse.status)
    }
    const sendAlertResult = await sendAlertResponse.json().catch(() => ({}))
    console.log('[driftAlertRouter] sendAlert responded — sent:', sendAlertResult.sent)

    context.res = {
      status: 200,
      body:   { alerted: true, sendAlertResult },
    }
  } catch (callError) {
    console.error('[driftAlertRouter] error calling sendAlert:', callError.message)
    context.res = {
      status: 500,
      body:   { error: callError.message },
    }
  }

  console.log('[driftAlertRouter] ends')
}
