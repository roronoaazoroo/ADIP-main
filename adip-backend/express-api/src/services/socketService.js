// ============================================================
// FILE: services/socketService.js
// ROLE: Thin wrapper around global.io to broadcast drift events to connected browsers
// global.io is set in app.js — this wrapper keeps routes decoupled from app.js
// Room format: subscriptionId:resourceGroup (lowercased, matches app.js join logic)
// ============================================================


// ── broadcastDriftEvent START ────────────────────────────────────────────────
// Emits a driftEvent to the correct Socket.IO room derived from subscriptionId + resourceGroup
function broadcastDriftEvent(driftEvent) {
  console.log('[broadcastDriftEvent] starts — subscriptionId:', driftEvent?.subscriptionId)
  if (!global.io) {
    console.log('[broadcastDriftEvent] ends — no global.io available')
    return
  }
  // Build the room name matching the format used in app.js socket.join()
  const targetRoom = driftEvent.resourceGroup
    ? `${driftEvent.subscriptionId}:${driftEvent.resourceGroup}`.toLowerCase()
    : driftEvent.subscriptionId?.toLowerCase()
  global.io.to(targetRoom).emit('resourceChange', driftEvent)
  console.log('[broadcastDriftEvent] ends — emitted to room:', targetRoom)
}
// ── broadcastDriftEvent END ──────────────────────────────────────────────────

module.exports = { broadcastDriftEvent }