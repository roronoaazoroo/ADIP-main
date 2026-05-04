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
import { onResourceChange, subscribeScope, isConnected } from '../services/socketSingleton'
 
 
 
// ── useDriftSocket START ─────────────────────────────────────────────────────
// React hook that manages the Socket.IO connection and real-time drift event feed
// Parameters:
//   scope           — { subscriptionId, resourceGroup, resourceId } — the selected scope
//   isSubmitted     — gate flag: events are ignored until this is true (user clicked Submit)
//   onConfigUpdate  — callback called with each event so DriftScanner can update the JSON tree
//   externalEvents  — if provided, the hook writes events here instead of its own local state
//   setExternalEvents — setter for externalEvents (used by DriftScanner via DashboardContext)
export function useDriftSocket(scopeOrScopes, isSubmitted = false, onConfigUpdate = null, externalEvents = null, setExternalEvents = null) {
  // Fall back to local state if no external state is provided
  const [localEventList, setLocalEventList] = useState([])

  // Use external state if provided (DriftScanner passes its own driftEvents state)
  const liveEventList    = externalEvents    ?? localEventList
  const setLiveEventList = setExternalEvents ?? setLocalEventList

  // Whether the Socket.IO connection is currently active
  const [socketConnected, setSocketConnected] = useState(false)

  // Whether the last connection attempt failed (shows error indicator in UI)
  const [socketError, setSocketError] = useState(false)

  // Ref that tracks whether the component is still mounted — prevents state updates after unmount

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
 
  // Subscribe to global socket singleton — persists across navigation
  useEffect(() => {
    // Normalise: accept single scope object or array of scopes
    const scopes = Array.isArray(scopeOrScopes) ? scopeOrScopes : [scopeOrScopes]
    const validScopes = scopes.filter(s => s?.subscriptionId)
    if (!validScopes.length) return
    // Subscribe to all scope rooms
    validScopes.forEach(s => subscribeScope({ subscriptionId: s.subscriptionId, resourceGroup: s.resourceGroup || s.resourceGroupId, resourceId: s.resourceId || null }))
    setSocketConnected(isConnected())

    // Register event listener — matches ANY of the selected scopes
    const unsubscribe = onResourceChange((incomingDriftEvent) => {
      if (!isSubmittedRef.current) return
      const matchesAnyScope = validScopes.some(scope => {
        const matchesSub = incomingDriftEvent.subscriptionId === scope.subscriptionId
        const rg = scope.resourceGroup || scope.resourceGroupId
        const matchesRG  = !rg || incomingDriftEvent.resourceGroup === rg
        const matchesRes = !scope.resourceId ||
          incomingDriftEvent.resourceId?.toLowerCase() === scope.resourceId?.toLowerCase() ||
          incomingDriftEvent.resourceId?.toLowerCase().endsWith(`/${scope.resourceId?.split('/').pop()?.toLowerCase()}`)
        return matchesSub && matchesRG && matchesRes
      })
      if (!matchesAnyScope) return
      addEvent(incomingDriftEvent)
      if (onConfigUpdate && incomingDriftEvent.resourceId) onConfigUpdate(incomingDriftEvent)
    })
    return unsubscribe
  }, [JSON.stringify(scopeOrScopes), addEvent, onConfigUpdate])
 
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