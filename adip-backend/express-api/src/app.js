require('dotenv').config()
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
app.use('/api', require('./routes/compare'))
app.use('/api', require('./routes/remediate'))
app.use('/api', require('./routes/seed'))
app.use('/api', require('./routes/policy'))

// Alert email endpoint — called by Logic App or directly
app.post('/api/alert/email', express.json(), async (req, res) => {
  const { sendDriftAlert } = require('./services/alertService')
  await sendDriftAlert(req.body).catch(() => {})
  res.json({ sent: true })
})

// SignalR webhook — Function App posts drift events here
app.post('/internal/drift-event', express.json(), (req, res) => {
  const event = req.body
  if (event?.subscriptionId) {
    const room = event.resourceGroup
      ? `${event.subscriptionId}:${event.resourceGroup}`
      : event.subscriptionId
    io.to(room).emit('driftEvent', event)
    sendDriftAlert(event).catch(err => console.error('[Alert]', err.message))
  }
  res.sendStatus(200)
})

const PORT = process.env.PORT || 3001
server.listen(PORT, () => {
  console.log(`ADIP API running on port ${PORT}`)
  startQueuePoller()
})
