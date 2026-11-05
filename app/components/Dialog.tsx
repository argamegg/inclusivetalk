'use client'

import { useEffect, useId, useRef } from 'react'

interface Props {
  title: React.ReactNode
  closeLabel: string
  onClose: () => void
  children: React.ReactNode
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * Accessible modal dialog: role="dialog", Esc closes, focus is trapped inside
 * and returned to the element that opened it. Mark the safest action with
 * `data-autofocus` to focus it first.
 */
export default function Dialog({ title, closeLabel, onClose, children }: Props) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    // Focus the element marked data-autofocus (e.g. the safe choice), else the dialog itself
    const preferred = panel?.querySelector<HTMLElement>('[data-autofocus]')
    ;(preferred ?? panel)?.focus()
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCloseRef.current()
        return
      }
      if (e.key !== 'Tab' || !panel) return
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) { e.preventDefault(); return }
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        e.preventDefault(); last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = prevOverflow
      opener?.focus()
    }
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" aria-hidden="true" onClick={() => onCloseRef.current()} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="it-surface it-text it-border relative z-10 w-full max-w-md max-h-[calc(100vh-2rem)] overflow-y-auto bg-white dark:bg-gray-900 border border-transparent rounded-2xl shadow-2xl"
      >
        <div className="it-border flex items-center justify-between gap-4 px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 id={titleId} className="it-text text-lg font-semibold text-gray-900 dark:text-white">{title}</h2>
          <button
            onClick={() => onCloseRef.current()}
            aria-label={closeLabel}
            className="it-text w-10 h-10 shrink-0 flex items-center justify-center rounded-lg text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-300 dark:hover:text-white dark:hover:bg-gray-800 text-xl leading-none transition-colors"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  )
}
