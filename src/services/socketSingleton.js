// ============================================================
// FILE: src/services/socketSingleton.js
// ROLE: Global Socket.IO singleton — persists across page navigation.
//
// The socket connects once and stays connected for the app lifetime.
// Components subscribe to events via callbacks registered here.
// This prevents events being lost when navigating between pages.
// ============================================================
import { io } from 'socket.io-client'

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001'

let socket = null
const listeners = new Set()

function getSocket() {
  if (!socket) {
    socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
    })

    socket.on('resourceChange', (event) => {
      listeners.forEach(cb => { try { cb(event) } catch {} })
    })
  }
  return socket
}

// Subscribe to incoming resourceChange events
export function onResourceChange(callback) {
  listeners.add(callback)
  return () => listeners.delete(callback)  // returns unsubscribe fn
}

// Join a scope room on the server
export function subscribeScope({ subscriptionId, resourceGroup, resourceId }) {
  const s = getSocket()
  if (s.connected) {
    s.emit('subscribe', { subscriptionId, resourceGroup: resourceGroup || null, resourceId: resourceId || null })
  } else {
    s.once('connect', () => {
      s.emit('subscribe', { subscriptionId, resourceGroup: resourceGroup || null, resourceId: resourceId || null })
    })
  }
}

export function isConnected() {
  return socket?.connected ?? false
}

// Initialise on import
getSocket()
