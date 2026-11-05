import { useEffect } from 'react'

/**
 * Keeps the screen on while `active` is true (Screen Wake Lock API).
 * A student who only reads captions never touches the phone, and a teacher
 * who is talking never touches the laptop — without this the screen sleeps mid-lesson.
 *
 * The browser drops the lock when the tab is hidden, so it is re-acquired
 * when the tab becomes visible again. Silently does nothing where unsupported
 * (old browsers, or plain http:// on a LAN — the API needs a secure context).
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || !('wakeLock' in navigator)) return

    let lock: WakeLockSentinel | null = null
    let cancelled = false

    const acquire = async () => {
      if (cancelled || document.visibilityState !== 'visible' || (lock && !lock.released)) return
      try {
        lock = await navigator.wakeLock.request('screen')
        if (cancelled) await lock.release()
      } catch {
        /* denied (e.g. battery saver) — the lesson still works, the screen may just sleep */
      }
    }

    const onVisibility = () => { void acquire() }

    void acquire()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      if (lock && !lock.released) void lock.release()
    }
  }, [active])
}
