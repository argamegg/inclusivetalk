import { useSyncExternalStore } from 'react'

const subscribe = () => () => {}

/**
 * false during SSR and hydration, true afterwards.
 * Lets components show browser-only state (localStorage, theme) without hydration mismatches.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false)
}
