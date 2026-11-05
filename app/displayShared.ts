/**
 * Display settings shared by the client store (displaySettings.ts) and the
 * server layout's inline <head> script. No React imports here — layout.tsx is a Server Component.
 */

export const CAPTION_SIZES = ['s', 'm', 'l', 'xl', 'xxl'] as const
export type CaptionSize = typeof CAPTION_SIZES[number]

export interface DisplaySettings {
  captionSize: CaptionSize
  contrast: 'normal' | 'high'
  font: 'default' | 'readable'
  captionMode: 'feed' | 'last'
  motion: 'system' | 'reduce'
}

export const DEFAULT_DISPLAY: DisplaySettings = {
  captionSize: 'm',
  contrast: 'normal',
  font: 'default',
  captionMode: 'feed',
  motion: 'system',
}

export const STORAGE_KEY = 'inclusivetalk_display'

export const ALLOWED: { [K in keyof DisplaySettings]: readonly DisplaySettings[K][] } = {
  captionSize: CAPTION_SIZES,
  contrast: ['normal', 'high'],
  font: ['default', 'readable'],
  captionMode: ['feed', 'last'],
  motion: ['system', 'reduce'],
}

/**
 * Inline script for <head>: applies saved settings before first paint on /student,
 * so a high-contrast user never sees a white flash.
 */
export const DISPLAY_INIT_SCRIPT = `
if (location.pathname.indexOf('/student') === 0) {
  var x = JSON.parse(localStorage.getItem('${STORAGE_KEY}') || '{}');
  var allowed = ${JSON.stringify({ captionSize: CAPTION_SIZES, contrast: ALLOWED.contrast, font: ALLOWED.font, motion: ALLOWED.motion })};
  for (var k in allowed) if (allowed[k].indexOf(x[k]) !== -1) document.documentElement.dataset[k] = x[k];
  var l = localStorage.getItem('inclusivetalk_student_lang');
  if (l === 'ru' || l === 'kk' || l === 'en') document.documentElement.lang = l;
}`
