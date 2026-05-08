// ============================================================
// FILE: src/hooks/useVisiblePolling.js
// ROLE: Visibility-aware polling — pauses when tab is hidden,
//       supports stale-while-revalidate and backoff
// ============================================================
import { useEffect, useRef, useCallback } from 'react'

/**
 * @param {Function} fetchFn - async function to call
 * @param {number} interval - polling interval in ms
 * @param {object} options - { enabled, backoffOnError, maxBackoff }
 */
export default function useVisiblePolling(fetchFn, interval, options = {}) {
  const { enabled = true, backoffOnError = true, maxBackoff = 60000 } = options
  const timerRef = useRef(null)
  const backoffRef = useRef(interval)
  const mountedRef = useRef(true)

  const poll = useCallback(async () => {
    if (!mountedRef.current) return
    try {
      await fetchFn()
      backoffRef.current = interval // reset on success
    } catch {
      if (backoffOnError) {
        backoffRef.current = Math.min(backoffRef.current * 1.5, maxBackoff)
      }
    }
    if (mountedRef.current && document.visibilityState === 'visible') {
      timerRef.current = setTimeout(poll, backoffRef.current)
    }
  }, [fetchFn, interval, backoffOnError, maxBackoff])

  useEffect(() => {
    mountedRef.current = true
    if (!enabled) return

    // Start polling
    timerRef.current = setTimeout(poll, interval)

    // Pause/resume on visibility change
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (!timerRef.current) timerRef.current = setTimeout(poll, 0)
      } else {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      mountedRef.current = false
      clearTimeout(timerRef.current)
      timerRef.current = null
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled, poll, interval])
}
