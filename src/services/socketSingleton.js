// FILE: src/services/socketSingleton.js
// ROLE: Global Socket.IO singleton — persists across page navigation.

// The socket connects once and stays connected for the app lifetime.
// Components subscribe to events via callbacks registered here.
// This prevents events being lost when navigating between pages.

import { io } from 'socket.io-client'

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001'

let socket = null
const listeners = new Set()

export function getSocket() {
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

    // Re-subscribe to all active scopes on reconnect
    socket.on('connect', () => {
      if (activeScopes.size > 0) {
        activeScopes.forEach(key => {
          socket.emit('subscribe', JSON.parse(key))
        })
      }
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
// Track active subscriptions for reconnect re-subscription
const activeScopes = new Set()

export function subscribeScope({ subscriptionId, resourceGroup, resourceId }) {
  const key = JSON.stringify({ subscriptionId, resourceGroup: resourceGroup || null, resourceId: resourceId || null })
  activeScopes.add(key)
  const s = getSocket()
  const payload = { subscriptionId, resourceGroup: resourceGroup || null, resourceId: resourceId || null }
  if (s.connected) {
    s.emit('subscribe', payload)
  } else {
    s.once('connect', () => s.emit('subscribe', payload))
  }
}

export function unsubscribeAllScopes() {
  activeScopes.clear()
}

export function isConnected() {
  return socket?.connected ?? false
}

// Initialise on import
getSocket()

