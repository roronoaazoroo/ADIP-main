// Socket.IO REST broadcast helper (used by Function App webhook path)
// Socket.IO handles the actual frontend push via global.io in app.js


// ── broadcastDriftEvent START ────────────────────────────────────────────────
// Emits a driftEvent to the correct Socket.IO room derived from subscriptionId + resourceGroup
function broadcastDriftEvent(event) {
  console.log('[broadcastDriftEvent] starts — subscriptionId:', event?.subscriptionId)
  if (!global.io) {
    console.log('[broadcastDriftEvent] ends — no global.io available')
    return
  }
  const room = event.resourceGroup
    ? `${event.subscriptionId}:${event.resourceGroup}`
    : event.subscriptionId
  global.io.to(room).emit('driftEvent', event)
  console.log('[broadcastDriftEvent] ends — emitted to room:', room)
}
// ── broadcastDriftEvent END ──────────────────────────────────────────────────

module.exports = { broadcastDriftEvent }