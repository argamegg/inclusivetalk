import type { SignalType } from './types'

export type Lang = 'ru' | 'kk' | 'en'

export const LANGS: readonly Lang[] = ['ru', 'kk', 'en']

export const LANG_NAMES: Record<Lang, string> = {
  ru: 'Русский',
  kk: 'Қазақша',
  en: 'English',
}

// -700 shades keep white text at WCAG AA contrast (≥ 4.5:1) and look calmer than -500
export const SIGNALS: Array<{ type: SignalType; icon: string; bg: string; activeBg: string }> = [
  { type: 'confused',   icon: '🤔', bg: 'bg-amber-700',   activeBg: 'active:bg-amber-800'   },
  { type: 'repeat',     icon: '🔁', bg: 'bg-blue-700',    activeBg: 'active:bg-blue-800'    },
  { type: 'slow',       icon: '⏸',  bg: 'bg-violet-700',  activeBg: 'active:bg-violet-800'  },
  { type: 'question',   icon: '❓', bg: 'bg-red-700',     activeBg: 'active:bg-red-800'     },
  { type: 'understood', icon: '✓',  bg: 'bg-emerald-700', activeBg: 'active:bg-emerald-800' },
]

export const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001/ws'

export const MAX_RECONNECT_ATTEMPTS = 5

export function reconnectDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** (attempt - 1), 32_000)
}

/** Unique id that also works on plain http:// (crypto.randomUUID needs a secure context). */
export function makeId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** True when the user (system setting or our "calm mode") prefers less motion. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return document.documentElement.dataset.motion === 'reduce'
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
