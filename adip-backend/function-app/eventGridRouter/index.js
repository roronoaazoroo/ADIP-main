// FILE: adip-backend/function-app/eventGridRouter/index.js
// ROLE: Azure Function — replaces adip-logic-app Logic App

// Trigger: HTTP POST from Azure Event Grid (webhook subscription)

// What this function does:
//   1. Handles the Event Grid webhook validation handshake
//      (Event Grid sends a SubscriptionValidationEvent on first setup —
//       must respond with validationResponse to confirm the endpoint)
//   2. Filters out noise events that should not trigger drift detection:
//      - Failed operations (status = 'Failed')
//      - Read/list operations (operationName contains 'read' or 'list')
//      - ARM deployment events (resourceUri contains '/deployments/')
//   3. For events that pass the filter: calls the detectDrift Azure Function
//      with { resourceId, subscriptionId } extracted from the event payload
//   4. Returns the detectDrift response to Event Grid

// Replaces: adip-logic-app Logic App
// Called by: Azure Event Grid (ResourceWriteSuccess / ResourceDeleteSuccess events)
// Calls: detectDrift Azure Function
'use strict'
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') })
const fetch = require('node-fetch')

// URL of the detectDrift Function — read from env so it works in any environment
// DETECT_DRIFT_FUNCTION_URL must be set — no hardcoded fallback (avoids accidental prod calls)
const DETECT_DRIFT_FUNCTION_URL = process.env.DETECT_DRIFT_FUNCTION_URL
const DETECT_DRIFT_FUNCTION_KEY = process.env.DETECT_DRIFT_FUNCTION_KEY || ''

module.exports = async function (context, req) {
  console.log('[eventGridRouter] starts')

  if (!DETECT_DRIFT_FUNCTION_URL) {
    context.log.error('[eventGridRouter] DETECT_DRIFT_FUNCTION_URL not configured')
    context.res = { status: 500, body: { error: 'DETECT_DRIFT_FUNCTION_URL not configured' } }
    return
  }

  const requestBody = req.body

  // Event Grid sends an array of events
  const eventArray = Array.isArray(requestBody) ? requestBody : [requestBody]
  const firstEvent = eventArray[0]

  //  Step 1: Handle Event Grid webhook validation handshake 
  // When you first create an Event Grid subscription pointing to this Function,
  // Event Grid sends a SubscriptionValidationEvent to verify the endpoint is live.
  // We must respond with the validationCode to confirm ownership.
  if (firstEvent?.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent') {
    const validationCode = firstEvent?.data?.validationCode
    console.log('[eventGridRouter] handling validation handshake — validationCode:', validationCode)
    context.res = {
      status: 200,
      body: { validationResponse: validationCode },
    }
    console.log('[eventGridRouter] ends — validation handshake complete')
    return
  }

  //  Step 2: Apply noise filters 
  // Skip events that should not trigger drift detection
  const eventData        = firstEvent?.data || {}
  const operationName    = (eventData.operationName || '').toLowerCase()
  const operationStatus  = (eventData.status || '').toLowerCase()
  const resourceUri      = (eventData.resourceUri || '').toLowerCase()

  const isFailedOperation     = operationStatus === 'failed'
  const isReadOrListOperation = operationName.includes('read') || operationName.includes('list')
  const isDeploymentEvent     = resourceUri.includes('/deployments/')

  if (isFailedOperation || isReadOrListOperation || isDeploymentEvent) {
    console.log('[eventGridRouter] event filtered out —',
      isFailedOperation ? 'failed operation' :
      isReadOrListOperation ? 'read/list operation' :
      'deployment event'
    )
    context.res = {
      status: 200,
      body: { skipped: true, reason: 'filtered by eventGridRouter' },
    }
    console.log('[eventGridRouter] ends — event skipped')
    return
  }

  //  Step 3: Call detectDrift Function 
  // Pass the resourceId and subscriptionId extracted from the Event Grid payload
  const resourceId     = eventData.resourceUri || firstEvent?.subject || ''
  const subscriptionId = eventData.subscriptionId || resourceId.split('/')?.[2] || ''
  const caller         = eventData.claims?.name
    || eventData.claims?.['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn']
    || eventData.caller
    || 'System'

  console.log('[eventGridRouter] calling detectDrift — resourceId:', resourceId, 'caller:', caller)

  const detectDriftUrl = DETECT_DRIFT_FUNCTION_KEY
    ? `${DETECT_DRIFT_FUNCTION_URL}?code=${DETECT_DRIFT_FUNCTION_KEY}`
    : DETECT_DRIFT_FUNCTION_URL

  try {
    const detectDriftResponse = await fetch(detectDriftUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ resourceId, subscriptionId, caller }),
    })

    if (!detectDriftResponse.ok) {
      const errorBody = await detectDriftResponse.text().catch(() => '')
      context.log.error('[eventGridRouter] detectDrift returned error:', detectDriftResponse.status, errorBody)
    }
    if (!detectDriftResponse.ok) {
      context.log.error('[eventGridRouter] detectDrift returned error:', detectDriftResponse.status)
    }
    const detectDriftResult = await detectDriftResponse.json().catch(() => ({}))
    console.log('[eventGridRouter] detectDrift responded — drifted:', detectDriftResult.drifted, 'severity:', detectDriftResult.severity)

    context.res = {
      status: 200,
      body:   detectDriftResult,
    }
  } catch (callError) {
    console.error('[eventGridRouter] error calling detectDrift:', callError.message)
    context.res = {
      status: 500,
      body:   { error: callError.message },
    }
  }

  console.log('[eventGridRouter] ends')
}
