'use client'

import { useId } from 'react'
import Dialog from './Dialog'
import type { UILabels } from '../i18n'
import {
  CAPTION_SIZES,
  resetDisplaySettings,
  updateDisplaySettings,
  useDisplaySettings,
  type DisplaySettings,
} from '../displaySettings'

interface Props {
  t: UILabels
  onClose: () => void
}

function Choice<K extends keyof DisplaySettings>({
  legend, setting, options,
}: {
  legend: string
  setting: K
  options: Array<{ value: DisplaySettings[K]; label: string }>
}) {
  const name = useId()
  const settings = useDisplaySettings()
  return (
    <fieldset className="space-y-2">
      <legend className="it-text text-sm font-semibold text-gray-800 dark:text-gray-100 mb-2">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map(opt => (
          <label key={String(opt.value)} className="cursor-pointer">
            <input
              type="radio"
              name={name}
              className="peer sr-only"
              checked={settings[setting] === opt.value}
              onChange={() => updateDisplaySettings({ [setting]: opt.value } as Partial<DisplaySettings>)}
            />
            <span className="it-choice block min-w-11 px-3 py-2 text-center rounded-lg border-2 text-sm font-medium transition-colors border-gray-300 text-gray-800 bg-white dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100 peer-checked:bg-blue-700 peer-checked:border-blue-700 peer-checked:text-white">
              {opt.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

export default function DisplaySettingsDialog({ t, onClose }: Props) {
  return (
    <Dialog title={t.displaySettings} closeLabel={t.close} onClose={onClose}>
      <div className="space-y-5">
        <div
          aria-hidden="true"
          className="it-surface it-border rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-950 px-4 py-3"
        >
          <p className="it-muted text-xs text-gray-600 dark:text-gray-300 mb-1">{t.preview}</p>
          <p className="it-caption font-medium text-gray-900 dark:text-white">Аа Әә Bb 123</p>
        </div>

        <Choice
          legend={t.captionSize}
          setting="captionSize"
          options={CAPTION_SIZES.map(size => ({ value: size, label: size.toUpperCase() }))}
        />
        <Choice
          legend={t.contrast}
          setting="contrast"
          options={[{ value: 'normal', label: t.contrastNormal }, { value: 'high', label: t.contrastHigh }]}
        />
        <Choice
          legend={t.font}
          setting="font"
          options={[{ value: 'default', label: t.fontDefault }, { value: 'readable', label: t.fontReadable }]}
        />
        <Choice
          legend={t.captionMode}
          setting="captionMode"
          options={[{ value: 'feed', label: t.captionFeed }, { value: 'last', label: t.captionLast }]}
        />
        <Choice
          legend={t.motion}
          setting="motion"
          options={[{ value: 'system', label: t.motionSystem }, { value: 'reduce', label: t.motionReduce }]}
        />

        <div className="flex gap-2 pt-1">
          <button
            onClick={resetDisplaySettings}
            className="it-text it-border flex-1 py-3 rounded-xl border-2 border-gray-300 dark:border-gray-600 text-gray-800 dark:text-gray-100 font-medium hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            {t.reset}
          </button>
          <button
            onClick={onClose}
            className="flex-1 py-3 rounded-xl bg-blue-700 hover:bg-blue-800 text-white font-medium transition-colors"
          >
            {t.done}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
