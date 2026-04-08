require('dotenv').config({ path: require('path').resolve(__dirname, '../../../.env') })
const express = require('express')
const cors = require('cors')
const http = require('http')
const { Server } = require('socket.io')
const { startQueuePoller } = require('./services/queuePoller')
const { sendDriftAlert }   = require('./services/alertService')

const app = express()
const server = http.createServer(app)

// Socket.IO for real-time frontend updates
const io = new Server(server, { cors: { origin: '*' } })
global.io = io

io.on('connection', (socket) => {
  socket.on('subscribe', ({ subscriptionId, resourceGroup }) => {
    const room = resourceGroup ? `${subscriptionId}:${resourceGroup}` : subscriptionId
    socket.join(room)
  })
})

app.use(cors())
app.use(express.json())

app.use('/api', require('./routes/subscriptions'))
app.use('/api', require('./routes/resourceGroups'))
app.use('/api', require('./routes/resources'))
app.use('/api', require('./routes/configuration'))
app.use('/api', require('./routes/scan'))
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
app.use('/api', require('./routes/chat'))

// Alert email endpoint — called by Logic App or directly
app.post('/api/alert/email', express.json(), async (req, res) => {
  const { sendDriftAlert } = require('./services/alertService')
  await sendDriftAlert(req.body).catch(() => {})
  res.json({ sent: true })
})

// Task 1: seed the live state cache so the next change event has a "previous" state
// Called by frontend immediately after config is loaded on Submit
app.post('/api/cache-state', express.json(), (req, res) => {
  const { resourceId, state } = req.body
  if (!resourceId || !state) return res.status(400).json({ error: 'resourceId and state required' })
  const { liveStateCache, cacheSet } = require('./services/queuePoller')
  const VOLATILE = ['etag','changedTime','createdTime','provisioningState','lastModifiedAt','systemData','_ts','_etag']
  function strip(obj) {
    if (Array.isArray(obj)) return obj.map(strip)
    if (obj && typeof obj === 'object')
      return Object.fromEntries(Object.entries(obj).filter(([k]) => !VOLATILE.includes(k)).map(([k,v]) => [k, strip(v)]))
    return obj
  }
  const stripped = strip(state)
  liveStateCache[resourceId] = stripped
  cacheSet(resourceId, stripped).catch(() => {})
  res.json({ cached: true, resourceId })
})

// SignalR webhook — Function App posts drift events here
app.post('/internal/drift-event', express.json(), (req, res) => {
  const event = req.body
  if (event?.subscriptionId) {
    const room = event.resourceGroup
      ? `${event.subscriptionId}:${event.resourceGroup}`
      : event.subscriptionId
    io.to(room).emit('resourceChange', event)  // unified event name
    sendDriftAlert(event).catch(err => console.error('[Alert]', err.message))
  }
  res.sendStatus(200)
})

const PORT = process.env.PORT || 3001
server.listen(PORT, () => {
  console.log(`ADIP API running on port ${PORT}`)
  startQueuePoller()
})
