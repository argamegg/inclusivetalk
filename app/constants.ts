import type { SignalType } from './types'

export type Lang = 'ru' | 'kk' | 'en'

export const LANGS: readonly Lang[] = ['ru', 'kk', 'en']

export const LANG_NAMES: Record<Lang, string> = {
  ru: 'Русский',
  kk: 'Қазақша',
  en: 'English',
}

export const SIGNALS: Array<{ type: SignalType; icon: string; bg: string; activeBg: string }> = [
  { type: 'confused',   icon: '🤔', bg: 'bg-amber-500',   activeBg: 'active:bg-amber-600'   },
  { type: 'repeat',     icon: '🔁', bg: 'bg-blue-500',    activeBg: 'active:bg-blue-600'    },
  { type: 'slow',       icon: '⏸',  bg: 'bg-violet-500',  activeBg: 'active:bg-violet-600'  },
  { type: 'question',   icon: '❓', bg: 'bg-red-500',     activeBg: 'active:bg-red-600'     },
  { type: 'understood', icon: '✓',  bg: 'bg-emerald-500', activeBg: 'active:bg-emerald-600' },
]

export const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:3001/ws'

export const MAX_RECONNECT_ATTEMPTS = 5

export function reconnectDelay(attempt: number): number {
  return Math.min(1_000 * 2 ** (attempt - 1), 32_000)
}
