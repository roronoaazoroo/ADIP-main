// ============================================================
// FILE: src/hooks/useDriftSocket.js
// ============================================================
import { useState, useEffect, useRef, useCallback } from 'react'
 
const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL ??
  import.meta.env.VITE_API_BASE_URL?.replace('/api', '') ??
  null
 
 
// ── useDriftSocket START ─────────────────────────────────────────────────────
// React hook that manages the Socket.IO connection and real-time drift event feed
export function useDriftSocket(scope, isSubmitted = false, onConfigUpdate = null, externalEvents = null, setExternalEvents = null) {
  console.log('[useDriftSocket] starts — scope:', scope?.subscriptionId)
  const [_localEvents, _setLocalEvents]       = useState([])
  const changeEvents    = externalEvents    ?? _localEvents
  const setChangeEvents = setExternalEvents ?? _setLocalEvents
  const [socketConnected, setSocketConnected] = useState(false)
  const [socketError, setSocketError]         = useState(false)
  const socketRef      = useRef(null)
  const mountedRef     = useRef(true)
  const isSubmittedRef = useRef(isSubmitted)
 
  useEffect(() => { isSubmittedRef.current = isSubmitted }, [isSubmitted])
 
  // ── addEvent START ───────────────────────────────────────────────────────
  // Appends a new drift event to the feed, capping the list at 200 entries
  const addEvent = useCallback((event) => {
    console.log('[addEvent] starts — eventId:', event.eventId)
    setChangeEvents(prev => {
      const key = event.eventId || (event.resourceId + ':' + event.eventTime)
      if (key && prev.some(e => (e.eventId || (e.resourceId + ':' + e.eventTime)) === key)) return prev
      return [...prev, {
        ...event,
        _clientId:   `${event.eventId ?? Date.now()}-${Math.random()}`,
        _receivedAt: new Date().toLocaleTimeString(),
      }].slice(-200)
    })
    console.log('[addEvent] ends')
  }, [setChangeEvents])
  // ── addEvent END ─────────────────────────────────────────────────────────
 
  // ── connectSocket START ──────────────────────────────────────────────────
  // Establishes the Socket.IO connection, subscribes to the scope room, and registers event listeners
  const connectSocket = useCallback(() => {
    console.log('[connectSocket] starts — SOCKET_URL:', SOCKET_URL)
    if (!SOCKET_URL || !scope?.subscriptionId) {
      console.log('[connectSocket] ends — no URL or subscriptionId')
      return
    }
    import('socket.io-client')
      .then(({ io }) => {
        if (!mountedRef.current) return
        socketRef.current?.disconnect()
        const socket = io(SOCKET_URL, { transports: ['websocket', 'polling'], reconnectionAttempts: Infinity, reconnectionDelay: 2000, reconnectionDelayMax: 10000 })
        socketRef.current = socket
 
        socket.on('connect', () => {
          console.log('[socket.connect] starts')
          if (!mountedRef.current) return
          setSocketConnected(true)
          setSocketError(false)
          socket.emit('subscribe', {
            subscriptionId: scope.subscriptionId,
            resourceGroup:  scope.resourceGroup || null,
            resourceId:     scope.resourceId || null,
          })
          console.log('[socket.connect] ends — subscribed to scope:', scope.subscriptionId)
        })
 
        socket.on('disconnect', () => {
          console.log('[socket.disconnect] fires')
          if (mountedRef.current) setSocketConnected(false)
        })
 
        socket.on('connect_error', () => {
          console.log('[socket.connect_error] fires')
          if (mountedRef.current) { setSocketConnected(false); setSocketError(true) }
        })

        socket.on('reconnect', () => {
          if (mountedRef.current) setSocketError(false)
        })
 
        // ── resourceChange handler START ───────────────────────────────────
        // Filters incoming events by scope and gates them behind the isSubmitted flag
        socket.on('resourceChange', (event) => {
          console.log('[socket.resourceChange] starts — resourceId:', event.resourceId)
          if (!mountedRef.current) return
          if (!isSubmittedRef.current) {
            console.log('[socket.resourceChange] ends — gated (not submitted)')
            return
          }
 
          const matchesSub = event.subscriptionId === scope.subscriptionId
          const matchesRG  = !scope.resourceGroup || event.resourceGroup === scope.resourceGroup
          const matchesRes = !scope.resourceId ||
            event.resourceId?.toLowerCase() === scope.resourceId?.toLowerCase() ||
            event.resourceId?.toLowerCase().endsWith(`/${scope.resourceId?.split('/').pop()?.toLowerCase()}`)
 
          if (!matchesSub || !matchesRG || !matchesRes) {
            console.log('[socket.resourceChange] ends — scope mismatch')
            return
          }
 
          addEvent(event)
 
          if (onConfigUpdate && event.resourceId) {
            onConfigUpdate(event)
          }
          console.log('[socket.resourceChange] ends — event added')
        })
        // ── resourceChange handler END ─────────────────────────────────────
      })
      .catch(() => {})
    console.log('[connectSocket] ends')
  }, [scope?.subscriptionId, scope?.resourceGroup, addEvent, onConfigUpdate])
  // ── connectSocket END ────────────────────────────────────────────────────
 
  useEffect(() => {
    mountedRef.current = true
    connectSocket()
    return () => {
      mountedRef.current = false
      socketRef.current?.disconnect()
      socketRef.current = null
    }
  }, [connectSocket])

  // Re-subscribe when scope changes on an already-connected socket
  useEffect(() => {
    if (socketRef.current?.connected && scope?.subscriptionId) {
      socketRef.current.emit('subscribe', {
        subscriptionId: scope.subscriptionId,
        resourceGroup:  scope.resourceGroup || null,
        resourceId:     scope.resourceId || null,
      })
    }
  }, [scope?.subscriptionId, scope?.resourceGroup, scope?.resourceId])
 
  // ── clearChangeEvents START ──────────────────────────────────────────────
  // Resets the drift event feed to empty
  const clearChangeEvents = useCallback(() => {
    console.log('[clearChangeEvents] starts')
    setChangeEvents([])
    console.log('[clearChangeEvents] ends')
  }, [setChangeEvents])
  // ── clearChangeEvents END ────────────────────────────────────────────────
 
  console.log('[useDriftSocket] ends — setup complete')
  return { driftEvents: changeEvents, socketConnected, socketError, clearDriftEvents: clearChangeEvents }
}
// ── useDriftSocket END ───────────────────────────────────────────────────────