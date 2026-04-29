// ============================================================
// FILE: adip-backend/express-api/src/app.js
// ROLE: Express server entry point — starts the API, Socket.IO, and queue poller
//
// What this file owns:
//   - Creates the HTTP server and attaches Socket.IO to it
//   - Stores the Socket.IO instance as global.io so all route files can emit events
//   - Registers all /api route files (subscriptions, drift, genome, ai, etc.)
//   - Handles POST /internal/drift-event (called by the detectDrift Azure Function)
//     to push drift events to connected browser clients via Socket.IO
//   - Starts the queue poller (reads Azure Storage Queue every 5s)
//   - Starts the after-hours alert check (fires at 19:00 if critical drift exists)
//
// Called by: `node src/app.js` or `npm start` in adip-backend/express-api
// ============================================================
'use strict'
require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') })
// Auto-create required Table Storage tables on startup
async function ensureTables() {
  const { TableServiceClient } = require('@azure/data-tables')
  const svc = TableServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING)
  const required = ['changesIndex','driftIndex','genomeIndex','monitorSessions','suppressionRules','remediationSchedules','policyAssignments']
  for (const name of required) {
    await svc.createTable(name).catch(() => {})  // no-op if already exists
  }
  console.log('[ensureTables] all required tables verified')
}
ensureTables().catch(err => console.log('[ensureTables] error:', err.message))

const express = require('express')
const cors    = require('cors')
const http    = require('http')
const { Server }            = require('socket.io')
const { startQueuePoller }  = require('./services/queuePoller')
const { sendDriftAlertEmail } = require('./services/alertService')
const { stripVolatileFields } = require('./shared/armUtils')
const { liveStateCache, cacheSet } = require('./services/queuePoller')
const { getDriftRecords }   = require('./services/blobService')
// fetch removed — no longer used directly in app.js (moved to alertService.js)

const app = express()
const server = http.createServer(app)

// Socket.IO for real-time frontend updates
const io = new Server(server, { cors: { origin: '*' } })
global.io = io

// ── io.on connection START ───────────────────────────────────────────────────
// Handles new Socket.IO client connections and joins them to the appropriate subscription/RG room
io.on('connection', (socket) => {
  console.log('[io.connection] starts — socketId:', socket.id)
  socket.on('subscribe', ({ subscriptionId, resourceGroup, resourceId }) => {
    console.log('[io.subscribe] starts — subscriptionId:', subscriptionId, 'resourceGroup:', resourceGroup)
    const baseRoom = resourceGroup ? `${subscriptionId}:${resourceGroup}`.toLowerCase() : subscriptionId.toLowerCase()
    socket.join(baseRoom)
    if (resourceId) {
      const resName = String(resourceId).split('/').pop()?.toLowerCase()
      if (resName) socket.join(`${baseRoom}:${resName}`)
    }
    console.log('[io.subscribe] ends — joined room:', baseRoom)
  })
  console.log('[io.connection] ends')
})
// ── io.on connection END ─────────────────────────────────────────────────────

// CORS: restrict to known frontend origin in production via CORS_ORIGIN env var
const corsOrigin = process.env.CORS_ORIGIN || '*'
if (corsOrigin === '*') console.warn('[app] WARNING: CORS_ORIGIN not set — allowing all origins. Set CORS_ORIGIN in production.')
app.use(cors({ origin: corsOrigin }))
app.use(express.json())

app.use('/api', require('./routes/subscriptions'))
app.use('/api', require('./routes/resourceGroups'))
app.use('/api', require('./routes/resources'))
app.use('/api', require('./routes/configuration'))
app.use('/api', require('./routes/drift'))
app.use('/api', require('./routes/baseline'))
app.use('/api', require('./routes/baselineUpload'))
app.use('/api', require('./routes/compare'))
app.use('/api', require('./routes/remediate'))
app.use('/api', require('./routes/seed'))
app.use('/api', require('./routes/policy'))
app.use('/api', require('./routes/remediateDecision'))
app.use('/api', require('./routes/remediateRequest'))
app.use('/api', require('./routes/ai'))
app.use('/api', require('./routes/genome'))
app.use('/api', require('./routes/reports'))
app.use('/api', require('./routes/attribution'))
app.use('/api', require('./routes/dependencyGraph'))
app.use('/api', require('./routes/suppressionRules'))
app.use('/api', require('./routes/remediationSchedule'))
app.use('/api', require('./routes/driftImpact'))
app.use('/api', require('./routes/userPreferences'))
app.use('/api', require('./routes/chat'))
app.use('/api', require('./routes/rgPrediction'))




// ── POST /api/cache-state START ──────────────────────────────────────────────
// Seeds the live state cache with the current resource config so the first change event has a diff
app.post('/api/cache-state', express.json(), (req, res) => {
  console.log('[POST /api/cache-state] starts')
  const { resourceId, state } = req.body
  if (!resourceId || !state) {
    console.log('[POST /api/cache-state] ends — missing resourceId or state')
    return res.status(400).json({ error: 'resourceId and state required' })
  }
  // stripVolatileFields and liveStateCache/cacheSet imported at module top
  const stripped = stripVolatileFields(state)
  liveStateCache[resourceId] = stripped
  cacheSet(resourceId, stripped).catch(() => {})
  res.json({ cached: true, resourceId })
  console.log('[POST /api/cache-state] ends — cached resourceId:', resourceId)
})
// ── POST /api/cache-state END ────────────────────────────────────────────────


// ── POST /internal/drift-event START ────────────────────────────────────────
// Internal endpoint called by the Function App to push drift events to connected frontend clients
// Cross-path dedup: prevents same event emitted by both queue poller and Function App
const _emittedEvents = new Map()
function isAlreadyEmitted(event) {
  const key = (event.eventId || event.resourceId) + ':' + (event.eventTime || '')
  if (_emittedEvents.has(key)) return true
  _emittedEvents.set(key, Date.now())
  const cutoff = Date.now() - 30000
  for (const [k, ts] of _emittedEvents) if (ts < cutoff) _emittedEvents.delete(k)
  return false
}
// Expose so queue poller can pre-register events it already emitted
global._markEmitted = (event) => isAlreadyEmitted(event)

app.post('/internal/drift-event', express.json(), (req, res) => {
  console.log('[POST /internal/drift-event] starts')
  const event = req.body
  if (!event || typeof event !== 'object') { res.sendStatus(400); return }
  if (event?.subscriptionId) {
    if (isAlreadyEmitted(event)) { res.sendStatus(200); return }
    const room = event.resourceGroup
      ? `${event.subscriptionId}:${event.resourceGroup}`.toLowerCase()
      : event.subscriptionId.toLowerCase()
    io.to(room).emit('resourceChange', event)  // unified event name
    sendDriftAlertEmail(event).catch(() => {})  // fire-and-forget
  }
  res.sendStatus(200)
  console.log('[POST /internal/drift-event] ends')
})
// ── POST /internal/drift-event END ──────────────────────────────────────────

const PORT = process.env.PORT || 3001
server.listen(PORT, () => {
  console.log(`ADIP API running on port ${PORT}`)
  startQueuePoller()

// Schedule poller — checks for due remediation schedules every 60 seconds
const { processDueSchedules } = require('./services/remediationScheduleService')
setInterval(() => processDueSchedules().catch(err => console.log('[schedulePoller] error:', err.message)), 60000)
  startAfterHoursAlertCheck()
})

// ── After-hours critical drift alert ─────────────────────────────────────────
// Fires once per day after 19:00 if any critical drift records exist from today
function startAfterHoursAlertCheck() {
  let lastFiredDate = null   // tracks the calendar date (YYYY-MM-DD) we last fired

  setInterval(async () => {
    const now   = new Date()
    const today = now.toISOString().slice(0, 10)
    if (now.getHours() < 19) return              // before 7pm — skip
    if (lastFiredDate === today) return           // already fired today — skip


    try {
      const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID
      if (!subscriptionId) return

      const since         = new Date(today + 'T00:00:00.000Z').toISOString()
      const critical      = await getDriftRecords({ subscriptionId, severity: 'critical', limit: 50 })
      const todayCritical = critical.filter(r => r.detectedAt >= since)

      if (todayCritical.length === 0) { lastFiredDate = today; return }

      console.log(`[after-hours-alert] ${todayCritical.length} critical drift(s) found after 19:00 — sending alerts`)

      for (const record of todayCritical) {
        await sendDriftAlertEmail({ ...record, afterHoursAlert: true })
      }

      lastFiredDate = today
      console.log(`[after-hours-alert] done — fired for date ${today}`)
    } catch (e) {
      console.error('[after-hours-alert] error:', e.message)
    }
  }, 60 * 1000)  // check every minute
}
// ── After-hours critical drift alert END ─────────────────────────────────────