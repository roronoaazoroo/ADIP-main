import { useState, useEffect, useRef, useCallback } from 'react'

const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL ??
  import.meta.env.VITE_API_BASE_URL?.replace('/api', '') ??
  null

export function useDriftSocket(scope, isSubmitted = false, onConfigUpdate = null) {
  const [changeEvents, setChangeEvents]       = useState([])
  const [socketConnected, setSocketConnected] = useState(false)
  const socketRef      = useRef(null)
  const mountedRef     = useRef(true)
  const isSubmittedRef = useRef(isSubmitted)

  // Keep ref in sync so the socket handler always sees latest value
  useEffect(() => { isSubmittedRef.current = isSubmitted }, [isSubmitted])

  const addEvent = useCallback((event) => {
    setChangeEvents(prev =>
      [...prev, {
        ...event,
        _clientId:   `${event.eventId ?? Date.now()}-${Math.random()}`,
        _receivedAt: new Date().toLocaleTimeString(),
      }].slice(-200)
    )
  }, [])

  const connectSocket = useCallback(() => {
    if (!SOCKET_URL || !scope?.subscriptionId) return
    import('socket.io-client')
      .then(({ io }) => {
        if (!mountedRef.current) return
        socketRef.current?.disconnect()
        const socket = io(SOCKET_URL, { transports: ['websocket'], reconnectionAttempts: 5 })
        socketRef.current = socket

        socket.on('connect', () => {
          if (!mountedRef.current) return
          setSocketConnected(true)
          socket.emit('subscribe', {
            subscriptionId: scope.subscriptionId,
            resourceGroup:  scope.resourceGroup || null,
          })
        })
        socket.on('disconnect',    () => { if (mountedRef.current) setSocketConnected(false) })
        socket.on('connect_error', () => { if (mountedRef.current) setSocketConnected(false) })

        socket.on('resourceChange', (event) => {
          if (!mountedRef.current) return

          // Task 3: Gate — drop events until user has pressed Submit
          if (!isSubmittedRef.current) return

          const matchesSub = event.subscriptionId === scope.subscriptionId
          const matchesRG  = !scope.resourceGroup || event.resourceGroup === scope.resourceGroup
          // If a specific resource is selected, only show events for that resource
          const matchesRes = !scope.resourceId ||
            event.resourceId?.toLowerCase() === scope.resourceId?.toLowerCase() ||
            event.resourceId?.toLowerCase().endsWith(`/${scope.resourceId?.split('/').pop()?.toLowerCase()}`)
          if (!matchesSub || !matchesRG || !matchesRes) return

          addEvent(event)

          // Task 4: Live config update — merge changed resource into configData
          if (onConfigUpdate && event.resourceId) {
            onConfigUpdate(event)
          }
        })
      })
      .catch(() => {})
  }, [scope?.subscriptionId, scope?.resourceGroup, addEvent, onConfigUpdate])

  useEffect(() => {
    mountedRef.current = true
    connectSocket()
    return () => {
      mountedRef.current = false
      socketRef.current?.disconnect()
      socketRef.current = null
    }
  }, [connectSocket])

  const clearChangeEvents = useCallback(() => setChangeEvents([]), [])

  return { driftEvents: changeEvents, socketConnected, clearDriftEvents: clearChangeEvents }
}
