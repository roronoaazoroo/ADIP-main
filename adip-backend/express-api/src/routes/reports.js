// ============================================================
// FILE: adip-backend/express-api/src/routes/reports.js
// ROLE: HTTP endpoints for drift analysis reports
//
// POST /api/reports/generate  — generate report, save to blob, optionally email
// GET  /api/reports           — list saved reports for a subscription
// GET  /api/reports/view      — return HTML content of a specific report
// ============================================================
'use strict'
const router = require('express').Router()
const { generateAndSaveReport, listSavedReports } = require('../services/reportService')
const { BlobServiceClient } = require('@azure/storage-blob')

const REPORTS_CONTAINER = 'drift-reports'

// POST /api/reports/generate
// Body: { subscriptionId, periodDays?, sendEmail? }
router.post('/reports/generate', async (req, res) => {
  console.log('[POST /reports/generate] starts')
  const { subscriptionId, periodDays = 7, sendEmail = false, recipientEmail = '' } = req.body

  if (!subscriptionId) {
    return res.status(400).json({ error: 'subscriptionId required' })
  }
  if (subscriptionId.includes("'")) {
    return res.status(400).json({ error: 'Invalid characters in subscriptionId' })
  }

  try {
    const { blobKey, reportData } = await generateAndSaveReport(subscriptionId, Number(periodDays), sendEmail, recipientEmail)
    res.json({ generated: true, blobKey, summary: reportData })
    console.log('[POST /reports/generate] ends — blobKey:', blobKey)
  } catch (generateError) {
    console.log('[POST /reports/generate] ends — error:', generateError.message)
    res.status(500).json({ error: generateError.message })
  }
})

// GET /api/reports?subscriptionId=
// Returns list of saved reports for a subscription
router.get('/reports', async (req, res) => {
  console.log('[GET /reports] starts')
  const { subscriptionId } = req.query
  if (!subscriptionId) return res.status(400).json({ error: 'subscriptionId required' })

  try {
    const reports = await listSavedReports(subscriptionId)
    res.json(reports)
    console.log('[GET /reports] ends — found:', reports.length)
  } catch (listError) {
    console.log('[GET /reports] ends — error:', listError.message)
    res.status(500).json({ error: listError.message })
  }
})

// GET /api/reports/view?blobKey=
// Returns the HTML content of a specific report for inline viewing
router.get('/reports/view', async (req, res) => {
  console.log('[GET /reports/view] starts')
  const { blobKey } = req.query
  if (!blobKey) return res.status(400).json({ error: 'blobKey required' })

  try {
    const blobClient = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
    const buffer = await blobClient.getContainerClient(REPORTS_CONTAINER).getBlobClient(blobKey).downloadToBuffer()
    res.setHeader('Content-Type', 'text/html')
    res.send(buffer.toString('utf-8'))
    console.log('[GET /reports/view] ends — blobKey:', blobKey)
  } catch (viewError) {
    console.log('[GET /reports/view] ends — error:', viewError.message)
    res.status(404).json({ error: 'Report not found' })
  }
})

// DELETE /api/reports?blobKey=
router.delete('/reports', async (req, res) => {
  console.log('[DELETE /reports] starts')
  const { blobKey } = req.query
  if (!blobKey) return res.status(400).json({ error: 'blobKey required' })

  try {
    const blobClient = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
    await blobClient.getContainerClient(REPORTS_CONTAINER).getBlobClient(blobKey).delete()
    res.json({ deleted: true, blobKey })
    console.log('[DELETE /reports] ends — blobKey:', blobKey)
  } catch (deleteError) {
    console.log('[DELETE /reports] ends — error:', deleteError.message)
    res.status(404).json({ error: 'Report not found or already deleted' })
  }
})

module.exports = router
