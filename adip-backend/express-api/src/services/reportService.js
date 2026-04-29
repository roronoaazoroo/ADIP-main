// ============================================================
// FILE: adip-backend/express-api/src/services/reportService.js
// ROLE: Business logic for generating drift analysis reports
//
// Queries changesIndex and driftIndex Tables to aggregate:
//   - Total changes and drift events over a period
//   - Severity breakdown
//   - Top drifted resources
//   - Remediation status
//
// Separate from infrastructure (routes/reports.js handles HTTP)
// ============================================================
'use strict'
const { getDriftIndexTableClient, getChangesIndexTableClient } = require('./blobService')
const { BlobServiceClient } = require('@azure/storage-blob')

// Writes HTML content to the drift-reports container
async function saveReportBlob(blobKey, htmlContent) {
  const blobClient = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
  const blockBlob  = blobClient.getContainerClient(REPORTS_CONTAINER).getBlockBlobClient(blobKey)
  const buffer     = Buffer.from(htmlContent, 'utf-8')
  await blockBlob.upload(buffer, buffer.length, { blobHTTPHeaders: { blobContentType: 'text/html' } })
}
const { EmailClient } = require('@azure/communication-email')

// Report storage container — auto-created on first write by blobService
const REPORTS_CONTAINER = 'drift-reports'

// Default report period in days
const DEFAULT_REPORT_PERIOD_DAYS = parseInt(process.env.REPORT_PERIOD_DAYS || '7', 10)

/**
 * Aggregates drift and change data for a subscription over a time period.
 * @param {string} subscriptionId
 * @param {string} sinceISO - ISO timestamp for start of period
 * @returns {object} Report data: totals, severity breakdown, top resources
 */
async function aggregateReportData(subscriptionId, sinceISO) {
  console.log('[aggregateReportData] starts — subscriptionId:', subscriptionId, 'since:', sinceISO)

  const changesFilter = `PartitionKey eq '${subscriptionId}' and Timestamp ge datetime'${sinceISO}'`
  const driftFilter   = `PartitionKey eq '${subscriptionId}' and Timestamp ge datetime'${sinceISO}'`

  // Query changesIndex for all ARM events in the period
  const uniqueChangedResources = new Set()
  let totalChanges = 0
  for await (const entity of getChangesIndexTableClient().listEntities({ queryOptions: { filter: changesFilter } })) {
    totalChanges++
    if (entity.resourceId) uniqueChangedResources.add(entity.resourceId)
  }

  // Query driftIndex for severity-classified drift events
  const severityCounts    = { critical: 0, high: 0, medium: 0, low: 0 }
  const resourceDriftMap  = {}
  let totalDriftEvents    = 0
  let remediatedCount     = 0

  for await (const entity of getDriftIndexTableClient().listEntities({ queryOptions: { filter: driftFilter } })) {
    totalDriftEvents++
    const severity = entity.severity?.toLowerCase()
    if (severity && severityCounts[severity] !== undefined) severityCounts[severity]++

    const resourceId = entity.resourceId || 'unknown'
    if (!resourceDriftMap[resourceId]) {
      resourceDriftMap[resourceId] = { resourceId, driftCount: 0, severity: severity || 'low', lastDrift: entity.detectedAt, lastCaller: entity.caller || 'System' }
    }
    resourceDriftMap[resourceId].driftCount++
    const severityOrder = ['low', 'medium', 'high', 'critical']
    if (severityOrder.indexOf(severity) > severityOrder.indexOf(resourceDriftMap[resourceId].severity)) {
      resourceDriftMap[resourceId].severity = severity
    }
  }

  // Top 10 most drifted resources
  const topDriftedResources = Object.values(resourceDriftMap)
    .sort((a, b) => b.driftCount - a.driftCount)
    .slice(0, 10)
    .map(r => ({ ...r, resourceName: r.resourceId.split('/').pop() || r.resourceId }))

  console.log('[aggregateReportData] ends — changes:', totalChanges, 'drifts:', totalDriftEvents)
  return {
    period:               { since: sinceISO, until: new Date().toISOString() },
    totalChanges,
    totalDriftEvents,
    uniqueResourcesChanged: uniqueChangedResources.size,
    severityBreakdown:    severityCounts,
    topDriftedResources,
    remediatedCount,      // placeholder — remediation log not yet implemented
  }
}

/**
 * Builds an HTML report from aggregated data.
 * @param {object} reportData - Output of aggregateReportData()
 * @param {string} subscriptionId
 * @returns {string} HTML string
 */
function buildHtmlReport(reportData, subscriptionId) {
  const { period, totalChanges, totalDriftEvents, uniqueResourcesChanged, severityBreakdown, topDriftedResources } = reportData
  const periodStart = new Date(period.since).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const periodEnd   = new Date(period.until).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  const severityRows = Object.entries(severityBreakdown)
    .map(([sev, count]) => `<tr><td style="padding:8px;text-transform:capitalize">${sev}</td><td style="padding:8px;font-weight:700">${count}</td></tr>`)
    .join('')

  const resourceRows = topDriftedResources.slice(0, 5)
    .map(r => `<tr><td style="padding:8px;font-family:monospace;font-size:12px">${r.resourceName}</td><td style="padding:8px">${r.driftCount}</td><td style="padding:8px;text-transform:capitalize">${r.severity}</td><td style="padding:8px">${r.lastCaller || '—'}</td><td style="padding:8px;font-size:11px;color:#64748b">${r.lastDrift ? new Date(r.lastDrift).toLocaleString() : '—'}</td></tr>`)
    .join('')

  return `<!DOCTYPE html>
<html><head><title>ADIP Drift Report — ${periodStart} to ${periodEnd}</title>
<style>body{font-family:Segoe UI,Arial,sans-serif;max-width:700px;margin:40px auto;color:#1e293b}
h1{color:#0f172a}h2{color:#334155;font-size:16px;margin-top:28px}
.stat{display:inline-block;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px 24px;margin:8px;text-align:center}
.stat-value{display:block;font-size:28px;font-weight:700;color:#0f172a}
.stat-label{display:block;font-size:12px;color:#64748b;margin-top:4px}
table{width:100%;border-collapse:collapse;margin-top:12px}
th{background:#f1f5f9;padding:8px;text-align:left;font-size:12px;color:#64748b}
tr:nth-child(even){background:#f8fafc}
</style></head><body>
<h1>Azure Drift Intelligence Report</h1>
<p style="color:#64748b">Period: <strong>${periodStart}</strong> to <strong>${periodEnd}</strong> · Subscription: ${subscriptionId.slice(0,8)}...</p>
<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0">
<h2>Summary</h2>
<div>
  <div class="stat"><span class="stat-value">${totalChanges}</span><span class="stat-label">Total ARM Events</span></div>
  <div class="stat"><span class="stat-value">${totalDriftEvents}</span><span class="stat-label">Drift Events</span></div>
  <div class="stat"><span class="stat-value">${uniqueResourcesChanged}</span><span class="stat-label">Resources Changed</span></div>
</div>
<h2>Drift by Severity</h2>
<table><thead><tr><th>Severity</th><th>Count</th></tr></thead><tbody>${severityRows}</tbody></table>
<h2>Top Drifted Resources</h2>
<table><thead><tr><th>Resource</th><th>Drift Count</th><th>Max Severity</th><th>Last Changed By</th><th>Last Drift</th></tr></thead><tbody>${resourceRows}</tbody></table>
<hr style="border:none;border-top:1px solid #e2e8f0;margin:28px 0">
<p style="font-size:12px;color:#94a3b8">Generated by Azure Drift Intelligence Platform (ADIP) · ${new Date().toLocaleString()}</p>
</body></html>`
}

/**
 * Generates a report, saves it to blob storage, and optionally emails it.
 * @param {string} subscriptionId
 * @param {number} periodDays - Number of days to cover
 * @param {boolean} sendEmail - Whether to email the report
 * @returns {object} { blobKey, reportData }
 */
async function generateAndSaveReport(subscriptionId, periodDays = DEFAULT_REPORT_PERIOD_DAYS, sendEmail = false, recipientEmail = '') {
  console.log('[generateAndSaveReport] starts — subscriptionId:', subscriptionId, 'days:', periodDays)

  const sinceISO  = new Date(Date.now() - periodDays * 86400000).toISOString()
  const reportData = await aggregateReportData(subscriptionId, sinceISO)
  const htmlContent = buildHtmlReport(reportData, subscriptionId)

  // Save to blob storage — key includes subscription prefix and date for easy listing
  const reportDate = new Date().toISOString().slice(0, 10)
  const blobKey    = `${subscriptionId.slice(0, 8)}/${reportDate}-${periodDays}d-report.html`
  await saveReportBlob(blobKey, htmlContent)

  // Optionally send via ACS email (uses existing alertService pattern)
  if (sendEmail) {
    const to = recipientEmail || process.env.ALERT_RECIPIENT_EMAIL
    if (to) {
      await sendReportEmail(to, htmlContent, reportDate, periodDays, reportData).catch(emailError => {
        console.warn('[generateAndSaveReport] email send failed (non-fatal):', emailError.message)
      })
    } else {
      console.warn('[generateAndSaveReport] sendEmail=true but no recipient email configured')
    }
  }

  console.log('[generateAndSaveReport] ends — blobKey:', blobKey)
  return { blobKey, reportData }
}

/**
 * Lists all saved reports for a subscription from blob storage.
 * @param {string} subscriptionId
 * @returns {Array} List of report metadata
 */
async function listSavedReports(subscriptionId) {
  console.log('[listSavedReports] starts — subscriptionId:', subscriptionId)
  const { BlobServiceClient } = require('@azure/storage-blob')
  const blobClient = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
  const containerClient = blobClient.getContainerClient(REPORTS_CONTAINER)

  const reports = []
  const prefix  = subscriptionId.slice(0, 8) + '/'
  for await (const blob of containerClient.listBlobsFlat({ prefix })) {
    reports.push({
      blobKey:     blob.name,
      createdAt:   blob.properties.createdOn,
      sizeBytes:   blob.properties.contentLength,
      reportName:  blob.name.split('/').pop(),
    })
  }

  console.log('[listSavedReports] ends — found:', reports.length)
  return reports.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
}


/**
 * Sends the report HTML directly via Azure Communication Services.
 * @param {string} to - Recipient email address
 * @param {string} htmlContent - Full HTML report
 * @param {string} reportDate - e.g. '2026-04-28'
 * @param {number} periodDays
 * @param {object} reportData
 */
async function sendReportEmail(to, htmlContent, reportDate, periodDays, reportData) {
  console.log('[sendReportEmail] starts — to:', to)
  const connStr = process.env.COMMS_CONNECTION_STRING
  const sender  = process.env.SENDER_ADDRESS
  if (!connStr || !sender) {
    console.log('[sendReportEmail] ends — COMMS_CONNECTION_STRING or SENDER_ADDRESS not configured')
    return
  }
  const client = new EmailClient(connStr)
  const poller = await client.beginSend({
    senderAddress: sender,
    recipients:    { to: [{ address: to }] },
    content: {
      subject:   `ADIP Drift Report — ${reportDate} (${periodDays} days)`,
      html:      htmlContent,
      plainText: `Drift report for ${periodDays} days: ${reportData.totalDriftEvents} drift events, ${reportData.severityBreakdown.critical} critical. View the HTML version for full details.`,
    },
  })
  await poller.pollUntilDone()
  console.log('[sendReportEmail] ends — sent to:', to)
}

module.exports = { generateAndSaveReport, listSavedReports, aggregateReportData }
