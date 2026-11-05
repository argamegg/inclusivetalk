import { useSyncExternalStore } from 'react'
import {
  ALLOWED, CAPTION_SIZES, DEFAULT_DISPLAY, STORAGE_KEY,
  type CaptionSize, type DisplaySettings,
} from './displayShared'

export { CAPTION_SIZES, DEFAULT_DISPLAY, type CaptionSize, type DisplaySettings }

/**
 * Student-only display settings (caption size, contrast, font, caption mode, motion).
 * Stored in localStorage and applied as data-* attributes on <html>, which globals.css reads.
 * Applied only on the student page, so the teacher's UI is never affected.
 */

// Attributes that globals.css reacts to (captionMode is handled in React)
const ATTRS = { captionSize: 'captionSize', contrast: 'contrast', font: 'font', motion: 'motion' } as const

let cache: DisplaySettings | null = null
const listeners = new Set<() => void>()

function read(): DisplaySettings {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>
    const result = { ...DEFAULT_DISPLAY }
    for (const key of Object.keys(ALLOWED) as (keyof DisplaySettings)[]) {
      const value = raw[key]
      if ((ALLOWED[key] as readonly unknown[]).includes(value)) {
        (result as Record<string, unknown>)[key] = value
      }
    }
    return result
  } catch {
    return { ...DEFAULT_DISPLAY }
  }
}

export function getDisplaySettings(): DisplaySettings {
  if (!cache) cache = read()
  return cache
}

export function applyDisplaySettings(settings: DisplaySettings): void {
  const ds = document.documentElement.dataset
  for (const [key, attr] of Object.entries(ATTRS)) {
    ds[attr] = settings[key as keyof typeof ATTRS]
  }
}

export function clearDisplaySettings(): void {
  const ds = document.documentElement.dataset
  for (const attr of Object.values(ATTRS)) delete ds[attr]
}

export function updateDisplaySettings(patch: Partial<DisplaySettings>): void {
  cache = { ...getDisplaySettings(), ...patch }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cache)) } catch { /* storage unavailable */ }
  applyDisplaySettings(cache)
  listeners.forEach(l => l())
}

export function resetDisplaySettings(): void {
  updateDisplaySettings(DEFAULT_DISPLAY)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useDisplaySettings(): DisplaySettings {
  return useSyncExternalStore(subscribe, getDisplaySettings, () => DEFAULT_DISPLAY)
}
