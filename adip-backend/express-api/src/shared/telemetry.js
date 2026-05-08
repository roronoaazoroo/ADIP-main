// ============================================================
// FILE: adip-backend/express-api/src/shared/telemetry.js
// ROLE: Application Insights integration + structured logging
//       Provides distributed tracing, metrics, and telemetry
// ============================================================
'use strict'
const appInsights = require('applicationinsights')

let _client = null

function init() {
  const connStr = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING
  if (!connStr) {
    console.log('[telemetry] No APPLICATIONINSIGHTS_CONNECTION_STRING — telemetry disabled')
    return
  }
  appInsights.setup(connStr)
    .setAutoCollectRequests(true)
    .setAutoCollectPerformance(true)
    .setAutoCollectExceptions(true)
    .setAutoCollectDependencies(true)
    .setDistributedTracingMode(appInsights.DistributedTracingModes.AI_AND_W3C)
    .start()
  _client = appInsights.defaultClient
  console.log('[telemetry] Application Insights initialized')
}

function getClient() { return _client }

// ── Structured event tracking ────────────────────────────────────────────────

function trackRemediation(data) {
  if (!_client) return
  _client.trackEvent({
    name: 'Remediation',
    properties: {
      subscriptionId: data.subscriptionId,
      resourceGroup: data.resourceGroup,
      resourceCount: String(data.resourceCount || 0),
      successful: String(data.successful || 0),
      failed: String(data.failed || 0),
      duration: String(data.duration || 0),
      type: data.type || 'rg-level',
    },
  })
}

function trackArmCall(data) {
  if (!_client) return
  _client.trackDependency({
    target: 'Azure ARM',
    name: data.operation || 'getResourceConfig',
    data: data.resourceId || data.resourceGroup || '',
    duration: data.duration,
    resultCode: data.statusCode || 200,
    success: data.success !== false,
    dependencyTypeName: 'Azure',
  })
}

function trackAiCall(data) {
  if (!_client) return
  _client.trackDependency({
    target: 'Azure OpenAI',
    name: data.operation || 'chat',
    data: data.promptTokens ? `tokens:${data.promptTokens}` : '',
    duration: data.duration,
    resultCode: data.statusCode || 200,
    success: data.success !== false,
    dependencyTypeName: 'AI',
  })
  _client.trackMetric({ name: 'ai.tokens.used', value: data.totalTokens || 0 })
}

function trackDeployment(data) {
  if (!_client) return
  _client.trackEvent({
    name: 'Deployment',
    properties: {
      subscriptionId: data.subscriptionId,
      resourceGroup: data.resourceGroup,
      resources: String(data.resources || 0),
      successful: String(data.successful || 0),
      failed: String(data.failed || 0),
      skipped: String(data.skipped || 0),
      durationMs: String(data.duration || 0),
    },
  })
}

function trackQueueMessage(data) {
  if (!_client) return
  _client.trackEvent({
    name: 'QueueMessage',
    properties: {
      resourceId: data.resourceId,
      operation: data.operation,
      latencyMs: String(data.latency || 0),
      hasDrift: String(data.hasDrift || false),
    },
  })
}

function trackMetric(name, value) {
  if (!_client) return
  _client.trackMetric({ name, value })
}

function trackError(error, properties = {}) {
  if (!_client) return
  _client.trackException({ exception: error, properties })
}

module.exports = { init, getClient, trackRemediation, trackArmCall, trackAiCall, trackDeployment, trackQueueMessage, trackMetric, trackError }
