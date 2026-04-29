// FILE: src/hooks/useDriftSocket.js
// ROLE: React hook — manages the Socket.IO WebSocket connection and live drift event feed

// What this hook does:
//   - Connects to the Express Socket.IO server at VITE_SOCKET_URL
//   - Emits 'subscribe' to join the correct room (subscriptionId:resourceGroup[:resourceName])
//   - Listens for 'resourceChange' events pushed by the server
//   - Gates all incoming events behind isSubmitted — events are dropped until
//     the user clicks Submit on DriftScanner (prevents feed showing before scope is set)
//   - Filters events by scope (subscriptionId, resourceGroup, resourceId)
//   - Deduplicates events using eventId + eventTime as a composite key
//   - Caps the event list at 200 entries (oldest dropped)
//   - Re-subscribes automatically when scope changes

// Used by: DriftScanner.jsx
// Returns: { driftEvents, socketConnected, socketError, clearDriftEvents }

import { useState, useEffect, useRef, useCallback } from 'react'
 
const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL ??
  import.meta.env.VITE_API_BASE_URL?.replace('/api', '') ??
  null
 
 
// ── useDriftSocket START ─────────────────────────────────────────────────────
// React hook that manages the Socket.IO connection and real-time drift event feed
// Parameters:
//   scope           — { subscriptionId, resourceGroup, resourceId } — the selected scope
//   isSubmitted     — gate flag: events are ignored until this is true (user clicked Submit)
//   onConfigUpdate  — callback called with each event so DriftScanner can update the JSON tree
//   externalEvents  — if provided, the hook writes events here instead of its own local state
//   setExternalEvents — setter for externalEvents (used by DriftScanner via DashboardContext)
export function useDriftSocket(scope, isSubmitted = false, onConfigUpdate = null, externalEvents = null, setExternalEvents = null) {
  // Fall back to local state if no external state is provided
  const [localEventList, setLocalEventList] = useState([])

  // Use external state if provided (DriftScanner passes its own driftEvents state)
  const liveEventList    = externalEvents    ?? localEventList
  const setLiveEventList = setExternalEvents ?? setLocalEventList

  // Whether the Socket.IO connection is currently active
  const [socketConnected, setSocketConnected] = useState(false)

  // Whether the last connection attempt failed (shows error indicator in UI)
  const [socketError, setSocketError] = useState(false)

  // Ref to the Socket.IO client instance — using a ref so reconnects don't trigger re-renders
  const socketRef = useRef(null)

  // Ref that tracks whether the component is still mounted — prevents state updates after unmount
  const mountedRef = useRef(true)

  // Ref that mirrors the isSubmitted prop — used inside the Socket.IO event handler
  // A ref is needed because the handler forms a closure over the initial value of isSubmitted
  // Using a ref ensures the handler always reads the current value without re-subscribing
  const isSubmittedRef = useRef(isSubmitted)
 
  useEffect(() => { isSubmittedRef.current = isSubmitted }, [isSubmitted])
 
  // ── addEvent START ───────────────────────────────────────────────────────
  // Appends a new drift event to the feed, capping the list at 200 entries
  // addEvent — appends a new drift event to the live feed
  // Deduplicates using eventId (or resourceId+eventTime as fallback)
  // Caps the list at 200 entries — oldest events are dropped when limit is reached
  const addEvent = useCallback((incomingEvent) => {
    setLiveEventList(previousEvents => {
      // Build a dedup key from eventId, or fall back to resourceId:eventTime
      const dedupKey = incomingEvent.eventId || (incomingEvent.resourceId + ':' + incomingEvent.eventTime)
      // If we already have this event, ignore it
      const isDuplicate = dedupKey && previousEvents.some(
        existingEvent => (existingEvent.eventId || (existingEvent.resourceId + ':' + existingEvent.eventTime)) === dedupKey
      )
      if (isDuplicate) return previousEvents
      return [...previousEvents, {
        ...incomingEvent,
        _clientId:   `${incomingEvent.eventId ?? Date.now()}-${Math.random()}`,  // unique key for React list rendering
        _receivedAt: new Date().toLocaleTimeString(),  // when the browser received this event
      }].slice(-200)  // keep only the last 200 events
    })
  }, [setLiveEventList])
  // ── addEvent END ─────────────────────────────────────────────────────────
 
  // ── connectSocket START ──────────────────────────────────────────────────
  // Establishes the Socket.IO connection, subscribes to the scope room, and registers event listeners
  // connectSocket — creates the Socket.IO connection and registers all event handlers
  // Called once on mount (via useEffect below)
  // Re-runs only when subscriptionId, resourceGroup, or addEvent changes
  const connectSocket = useCallback(() => {
    if (!SOCKET_URL || !scope?.subscriptionId) return

    // Dynamically import socket.io-client to keep the initial bundle smaller
    import('socket.io-client')
      .then(({ io }) => {
        if (!mountedRef.current) return

        // Disconnect any existing socket before creating a new one
        socketRef.current?.disconnect()

        // Create the Socket.IO connection with automatic reconnection
        const socketConnection = io(SOCKET_URL, {
          transports: ['websocket', 'polling'],
          reconnectionAttempts: Infinity,
          reconnectionDelay: 2000,
          reconnectionDelayMax: 10000,
        })
        socketRef.current = socketConnection

        // On connect: join the correct room for the selected scope
        // The server uses this room to route events to the right clients
        socketConnection.on('connect', () => {
          if (!mountedRef.current) return
          setSocketConnected(true)
          setSocketError(false)
          socketConnection.emit('subscribe', {
            subscriptionId: scope.subscriptionId,
            resourceGroup:  scope.resourceGroup || null,
            resourceId:     scope.resourceId || null,
          })
        })

        socketConnection.on('disconnect', () => {
          if (mountedRef.current) setSocketConnected(false)
        })

        socketConnection.on('connect_error', () => {
          if (mountedRef.current) { setSocketConnected(false); setSocketError(true) }
        })

        socketConnection.on('reconnect', () => {
          if (mountedRef.current) setSocketError(false)
        })

        // Handle incoming drift events from the server
        // Events are emitted by queuePoller.js or /internal/drift-event in app.js
        socketConnection.on('resourceChange', (incomingDriftEvent) => {
          if (!mountedRef.current) return

          // Gate: ignore events until the user has clicked Submit on DriftScanner
          if (!isSubmittedRef.current) return

          // Scope filter: only accept events that match the selected subscription/RG/resource
          const eventMatchesSubscription = incomingDriftEvent.subscriptionId === scope.subscriptionId
          const eventMatchesResourceGroup = !scope.resourceGroup || incomingDriftEvent.resourceGroup === scope.resourceGroup
          const eventMatchesResource = !scope.resourceId ||
            incomingDriftEvent.resourceId?.toLowerCase() === scope.resourceId?.toLowerCase() ||
            incomingDriftEvent.resourceId?.toLowerCase().endsWith(`/${scope.resourceId?.split('/').pop()?.toLowerCase()}`)

          if (!eventMatchesSubscription || !eventMatchesResourceGroup || !eventMatchesResource) return

          // Add to the live feed
          addEvent(incomingDriftEvent)

          // Notify DriftScanner so it can update the JSON tree with the new live config
          if (onConfigUpdate && incomingDriftEvent.resourceId) {
            onConfigUpdate(incomingDriftEvent)
          }
        })
      })
      .catch(() => {})
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
  // clearDriftEvents — resets the live event feed to empty
  // Called by DriftScanner when the user clicks Stop
  const clearChangeEvents = useCallback(() => {
    setLiveEventList([])
  }, [setLiveEventList])
  // ── clearChangeEvents END ────────────────────────────────────────────────
 
  return { driftEvents: liveEventList, socketConnected, socketError, clearDriftEvents: clearChangeEvents }
}
// ── useDriftSocket END ───────────────────────────────────────────────────────