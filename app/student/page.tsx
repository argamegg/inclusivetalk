'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import type { SignalType } from '../types'
import ThemeToggle from '../components/ThemeToggle'
import GestureMockModal from '../components/GestureMockModal'
import DisplaySettingsDialog from '../components/DisplaySettingsDialog'
import SiteHeader from '../components/SiteHeader'
import { useMounted } from '../useMounted'
import { useWakeLock } from '../useWakeLock'
import { SIGNAL_LABELS, UI_LABELS, type UILabels } from '../i18n'
import {
  LANGS, LANG_NAMES, SIGNALS, getWsUrl, MAX_RECONNECT_ATTEMPTS,
  reconnectDelay, makeId, prefersReducedMotion, type Lang,
} from '../constants'
import { applyDisplaySettings, clearDisplaySettings, getDisplaySettings, useDisplaySettings } from '../displaySettings'

type StudentState = 'idle' | 'connecting' | 'active' | 'error'
type LabelKey = keyof UILabels
/** A caption line in its own language, or a note that the lesson language changed. */
interface CaptionLine { text: string; lang: Lang; note?: boolean }

const LS_NAME_KEY = 'inclusivetalk_student_name'
const LS_LANG_KEY = 'inclusivetalk_student_lang'
const LS_COMPACT_KEY = 'inclusivetalk_compact_signals'

const MAX_SUBTITLES = 200
const MAX_QUESTION_LEN = 500
const SIGNAL_COOLDOWN_MS = 2_000
const UNDO_WINDOW_MS = 6_000

const SERVER_ERRORS: Record<string, LabelKey> = {
  room_not_found: 'errRoomNotFound',
  name_required: 'errNameRequired',
}

function SettingsButton({ t, onClick }: { t: UILabels; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label={t.displaySettings}
      title={t.displaySettings}
      className="it-text w-9 h-9 flex items-center justify-center rounded-lg font-bold text-gray-700 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-200 dark:hover:text-white dark:hover:bg-gray-800 transition-colors"
    >
      <span aria-hidden="true">Aa</span>
    </button>
  )
}

export default function StudentPage() {
  // Name and language come from localStorage, so the form renders only after hydration
  const mounted = useMounted()
  const display = useDisplaySettings()

  const [state, setState] = useState<StudentState>('idle')
  const [studentLang, setStudentLang] = useState<Lang>(() => {
    if (typeof window === 'undefined') return 'ru'
    try {
      const saved = localStorage.getItem(LS_LANG_KEY)
      return LANGS.includes(saved as Lang) ? (saved as Lang) : 'ru'
    } catch { return 'ru' }
  })
  const [nameInput, setNameInput] = useState(() => {
    if (typeof window === 'undefined') return ''
    try { return localStorage.getItem(LS_NAME_KEY) ?? '' } catch { return '' }
  })
  const [codeInput, setCodeInput] = useState('')
  const [connectedCode, setConnectedCode] = useState('')
  const [connectedName, setConnectedName] = useState('')
  const [lessonLang, setLessonLang] = useState<Lang>('ru')
  const [subtitles, setSubtitles] = useState<CaptionLine[]>([])
  // Errors are stored as label keys, so they follow the chosen interface language
  const [errorKey, setErrorKey] = useState<LabelKey | null>(null)
  const [errorField, setErrorField] = useState<'name' | 'code' | null>(null)
  const [lessonEnded, setLessonEnded] = useState(false)

  const [reconnecting, setReconnecting] = useState(false)
  const [teacherReconnecting, setTeacherReconnecting] = useState(false)
  const [teacherMicOff, setTeacherMicOff] = useState(false)

  const [signalCooldown, setSignalCooldown] = useState(false)
  const [lastSignal, setLastSignal] = useState<{ id: string; type: SignalType } | null>(null)
  const [undoNotice, setUndoNotice] = useState(false)
  // Compact signal row frees screen space for captions (remembered on this device)
  const [compactSignals, setCompactSignals] = useState(() => {
    if (typeof window === 'undefined') return false
    try { return localStorage.getItem(LS_COMPACT_KEY) === 'on' } catch { return false }
  })
  // "The teacher saw: …" confirmation
  const [ackNotice, setAckNotice] = useState('')

  const [questionOpen, setQuestionOpen] = useState(false)
  const [questionText, setQuestionText] = useState('')
  const [questionSent, setQuestionSent] = useState(false)

  const [gestureOpen, setGestureOpen] = useState(false)
  const [gestureSent, setGestureSent] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [panelHeight, setPanelHeight] = useState(160)
  // Captions that arrived while the student was reading further up
  const [unseenCaptions, setUnseenCaptions] = useState(0)

  const wsRef = useRef<WebSocket | null>(null)
  const stateRef = useRef<StudentState>('idle')
  const lessonEndedRef = useRef(false)
  const userDisconnectedRef = useRef(false)
  const atBottomRef = useRef(true)
  const lessonLangRef = useRef<Lang>('ru')
  // What each sent signal/question/gesture was, so the teacher's "Seen" can be shown in words
  const sentRef = useRef(new Map<string, string>())
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const reconnectAttemptsRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const savedCodeRef = useRef('')
  const savedNameRef = useRef('')
  const connectWsRef = useRef<((code: string, name: string) => void) | null>(null)

  const t = UI_LABELS[studentLang]

  // Keep the phone screen on while captions are coming in
  useWakeLock(state === 'active' && !lessonEnded)

  const setStateSynced = useCallback((s: StudentState) => {
    stateRef.current = s
    setState(s)
  }, [])

  /** Restartable named timers, all cleared on leave/unmount. */
  const later = useCallback((name: string, ms: number, fn: () => void) => {
    clearTimeout(timersRef.current[name])
    timersRef.current[name] = setTimeout(fn, ms)
  }, [])

  const clearTimers = useCallback(() => {
    Object.values(timersRef.current).forEach(clearTimeout)
    timersRef.current = {}
  }, [])

  // Display settings apply only while the student page is open
  useEffect(() => {
    applyDisplaySettings(getDisplaySettings())
    return clearDisplaySettings
  }, [])

  // Page language follows the interface language (screen readers pick the right voice)
  useEffect(() => {
    document.documentElement.lang = studentLang
    return () => { document.documentElement.lang = 'ru' }
  }, [studentLang])

  // Scroll to the real bottom of the page: the padding below the captions keeps
  // the newest line above the fixed signal panel instead of hidden behind it
  const scrollPageToBottom = () => {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }

  const scrollToLatest = useCallback(() => {
    scrollPageToBottom()
    atBottomRef.current = true
    setUnseenCaptions(0)
  }, [])

  // Auto-scroll only if the student is already at the bottom — never pull them away while re-reading
  useEffect(() => {
    if (display.captionMode === 'feed' && atBottomRef.current) {
      scrollPageToBottom()
    }
  }, [subtitles, display.captionMode])

  useEffect(() => {
    if (state !== 'active') return
    // Only a scroll UP means "the student wants to re-read"; our own smooth auto-scroll
    // goes down and must not switch following off halfway through its animation.
    let lastY = window.scrollY
    const onScroll = () => {
      const y = window.scrollY
      const fromBottom = document.documentElement.scrollHeight - (y + window.innerHeight)
      if (fromBottom < 120) {
        atBottomRef.current = true
        setUnseenCaptions(0)
      } else if (y < lastY - 2) {
        atBottomRef.current = false
      }
      lastY = y
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [state])

  // Keep subtitles clear of the bottom panel, whatever its height (zoom, big text, open question)
  useEffect(() => {
    if (state !== 'active' || !panelRef.current) return
    const panel = panelRef.current
    const ro = new ResizeObserver(() => setPanelHeight(panel.offsetHeight))
    ro.observe(panel)
    return () => ro.disconnect()
  }, [state])

  useEffect(() => () => {
    wsRef.current?.close()
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
    clearTimers()
  }, [clearTimers])

  const resetLessonUi = useCallback(() => {
    clearTimers()
    setSignalCooldown(false)
    setLastSignal(null)
    setUndoNotice(false)
    setQuestionOpen(false)
    setQuestionText('')
    setQuestionSent(false)
    setGestureOpen(false)
    setGestureSent(false)
    setReconnecting(false)
    setTeacherReconnecting(false)
    setTeacherMicOff(false)
    setUnseenCaptions(0)
    setAckNotice('')
    sentRef.current.clear()
    atBottomRef.current = true
  }, [clearTimers])

  const changeLang = useCallback((lang: Lang) => {
    setStudentLang(lang)
    try { localStorage.setItem(LS_LANG_KEY, lang) } catch { /* storage unavailable */ }
  }, [])

  const connectWs = useCallback((code: string, name: string) => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }

    const ws = new WebSocket(getWsUrl())
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'register', role: 'student', code, name }))
    }

    ws.onmessage = (event: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(event.data) as Record<string, unknown>

        if (msg.type === 'joined') {
          try { localStorage.setItem(LS_NAME_KEY, name) } catch { /* storage unavailable */ }
          if (LANGS.includes(msg.language as Lang)) {
            lessonLangRef.current = msg.language as Lang
            setLessonLang(msg.language as Lang)
          }
          setTeacherMicOff(msg.micOn === false)
          reconnectAttemptsRef.current = 0
          setReconnecting(false)
          setStateSynced('active')

        } else if (msg.type === 'error') {
          setErrorKey(SERVER_ERRORS[String(msg.code)] ?? 'errServerUnreachable')
          setStateSynced('error')
          ws.onclose = null
          ws.close()
          wsRef.current = null

        } else if (msg.type === 'transcript') {
          const text = String(msg.text ?? '')
          const lang = LANGS.includes(msg.lang as Lang) ? (msg.lang as Lang) : lessonLangRef.current
          setSubtitles(prev => [...prev, { text, lang }].slice(-MAX_SUBTITLES))
          if (!atBottomRef.current && getDisplaySettings().captionMode === 'feed') setUnseenCaptions(n => n + 1)

        } else if (msg.type === 'lesson_language') {
          // Teacher switched language mid-lesson (common in RU/KZ classes): mark it in the feed
          if (!LANGS.includes(msg.language as Lang)) return
          const lang = msg.language as Lang
          lessonLangRef.current = lang
          setLessonLang(lang)
          setSubtitles(prev => [...prev, { text: '', lang, note: true }].slice(-MAX_SUBTITLES))

        } else if (msg.type === 'room_closed') {
          lessonEndedRef.current = true
          setLessonEnded(true)
          setReconnecting(false)
          setTeacherReconnecting(false)

        } else if (msg.type === 'teacher_disconnected') {
          setTeacherReconnecting(true)

        } else if (msg.type === 'teacher_reconnected') {
          setTeacherReconnecting(false)

        } else if (msg.type === 'acknowledged') {
          const id = String(msg.feedbackId ?? '')
          const what = sentRef.current.get(id)
          if (!what) return
          sentRef.current.delete(id)
          if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate([60, 40, 60])
          setLastSignal(prev => (prev?.id === id ? null : prev))  // seen → nothing to undo
          setAckNotice(what)
          later('ack', 4_000, () => setAckNotice(''))

        } else if (msg.type === 'teacher_mic') {
          setTeacherMicOff(msg.on === false)
        }
      } catch { /* ignore malformed */ }
    }

    ws.onclose = () => {
      if (wsRef.current !== ws) return  // we already moved on
      wsRef.current = null

      if (lessonEndedRef.current || userDisconnectedRef.current) return
      if (stateRef.current !== 'active' && stateRef.current !== 'connecting') return

      reconnectAttemptsRef.current += 1
      if (reconnectAttemptsRef.current > MAX_RECONNECT_ATTEMPTS) {
        setErrorKey(stateRef.current === 'connecting' ? 'errServerUnreachable' : 'errConnectionLost')
        setStateSynced('error')
        setReconnecting(false)
        return
      }

      setReconnecting(true)
      reconnectTimerRef.current = setTimeout(() => {
        if (!lessonEndedRef.current && !userDisconnectedRef.current) {
          connectWsRef.current?.(savedCodeRef.current, savedNameRef.current)
        }
      }, reconnectDelay(reconnectAttemptsRef.current))
    }

    ws.onerror = () => { /* onclose handles it */ }
  }, [setStateSynced, later])

  useEffect(() => {
    connectWsRef.current = connectWs
  }, [connectWs])

  const connect = useCallback(() => {
    const name = nameInput.trim()
    if (!name) {
      setErrorKey('errNameRequired'); setErrorField('name')
      document.getElementById('name-input')?.focus()
      return
    }
    if (!/^\d{6}$/.test(codeInput)) {
      setErrorKey('errCodeFormat'); setErrorField('code')
      document.getElementById('code-input')?.focus()
      return
    }
    setErrorKey(null)
    setErrorField(null)
    setStateSynced('connecting')
    setSubtitles([])
    resetLessonUi()
    lessonEndedRef.current = false
    userDisconnectedRef.current = false
    setLessonEnded(false)
    reconnectAttemptsRef.current = 0

    savedCodeRef.current = codeInput
    savedNameRef.current = name
    setConnectedCode(codeInput)
    setConnectedName(name)

    connectWs(codeInput, name)
  }, [nameInput, codeInput, setStateSynced, resetLessonUi, connectWs])

  const leave = useCallback(() => {
    userDisconnectedRef.current = true
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (wsRef.current) {
      const ws = wsRef.current
      wsRef.current = null
      ws.onclose = null
      ws.onerror = null
      ws.onmessage = null
      ws.close()
    }
    setStateSynced('idle')
    setSubtitles([])
    setConnectedCode('')
    setConnectedName('')
    resetLessonUi()
    lessonEndedRef.current = false
    setLessonEnded(false)
  }, [resetLessonUi, setStateSynced])

  const retry = useCallback(() => {
    userDisconnectedRef.current = false
    setStateSynced('idle')
    setErrorKey(null)
    setErrorField(null)
    resetLessonUi()
  }, [resetLessonUi, setStateSynced])

  const sendSignal = useCallback((signalType: SignalType) => {
    if (signalCooldown || lessonEnded || !wsRef.current) return
    if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(100)
    const id = makeId()
    wsRef.current.send(JSON.stringify({ type: 'signal', signalType, signalId: id }))
    sentRef.current.set(id, `«${SIGNAL_LABELS[studentLang][signalType]}»`)
    setSignalCooldown(true)
    setLastSignal({ id, type: signalType })
    setUndoNotice(false)
    later('cooldown', SIGNAL_COOLDOWN_MS, () => setSignalCooldown(false))
    later('undo', UNDO_WINDOW_MS, () => setLastSignal(null))
  }, [signalCooldown, lessonEnded, later, studentLang])

  const undoSignal = useCallback(() => {
    if (!lastSignal || !wsRef.current) return
    wsRef.current.send(JSON.stringify({ type: 'signal_cancel', signalId: lastSignal.id }))
    clearTimeout(timersRef.current.undo)
    setLastSignal(null)
    setSignalCooldown(false)
    setUndoNotice(true)
    later('undoNotice', 2_500, () => setUndoNotice(false))
  }, [lastSignal, later])

  const toggleCompactSignals = useCallback(() => {
    setCompactSignals(prev => {
      const next = !prev
      try { localStorage.setItem(LS_COMPACT_KEY, next ? 'on' : 'off') } catch { /* storage unavailable */ }
      return next
    })
  }, [])

  const sendQuestion = useCallback(() => {
    const text = questionText.trim()
    if (!text || questionSent || lessonEnded || !wsRef.current) return
    const id = makeId()
    wsRef.current.send(JSON.stringify({ type: 'question', text, feedbackId: id }))
    sentRef.current.set(id, t.yourQuestion)
    setQuestionText('')
    setQuestionOpen(false)
    setQuestionSent(true)
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    later('question', 3_000, () => setQuestionSent(false))
  }, [questionText, questionSent, lessonEnded, later, t])

  const sendGesture = useCallback((letter: string) => {
    if (!wsRef.current || lessonEnded) return
    const id = makeId()
    wsRef.current.send(JSON.stringify({ type: 'gesture', letter, feedbackId: id }))
    sentRef.current.set(id, t.gestureWhat.replace('{letter}', letter))
    setGestureSent(true)
    later('gesture', 3_000, () => setGestureSent(false))
  }, [lessonEnded, later, t])

  // Keyboard shortcuts 1–5 for quick signals (ignored while typing or in a dialog)
  useEffect(() => {
    if (state !== 'active') return
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || settingsOpen || gestureOpen) return
      const target = e.target as HTMLElement
      if (target.closest('input, textarea, [contenteditable="true"]')) return
      const index = Number(e.key) - 1
      if (Number.isInteger(index) && index >= 0 && index < SIGNALS.length) {
        e.preventDefault()
        sendSignal(SIGNALS[index].type)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, settingsOpen, gestureOpen, sendSignal])

  const settingsDialog = settingsOpen && (
    <DisplaySettingsDialog t={t} onClose={() => setSettingsOpen(false)} />
  )

  // ── Idle: join form ────────────────────────────────────────────────────────
  if (state === 'idle') {
    const errorText = errorKey ? t[errorKey] : ''
    return (
      <div className="it-surface min-h-screen flex flex-col bg-white dark:bg-gray-950">
        <SiteHeader>
          {mounted && <SettingsButton t={t} onClick={() => setSettingsOpen(true)} />}
        </SiteHeader>
        <main id="main" className="flex-1 flex items-center justify-center px-4 py-8">
          {mounted && (
            <form
              noValidate
              onSubmit={e => { e.preventDefault(); connect() }}
              className="w-full max-w-sm space-y-6"
            >
              <h1 className="it-text text-3xl font-bold text-center text-gray-900 dark:text-white">{t.student}</h1>

              <div className="space-y-2">
                <label htmlFor="name-input" className="it-text block text-base font-medium text-gray-800 dark:text-gray-200">
                  {t.yourName}
                </label>
                <input
                  id="name-input"
                  type="text"
                  maxLength={50}
                  value={nameInput}
                  onChange={e => { setNameInput(e.target.value); setErrorKey(null); setErrorField(null) }}
                  placeholder={t.nameExample}
                  autoComplete="name"
                  aria-invalid={errorField === 'name'}
                  aria-describedby={errorField === 'name' ? 'join-error' : undefined}
                  className="it-surface it-text it-border w-full text-xl py-3 px-4 border-2 border-gray-300 dark:border-gray-600 rounded-xl bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder:text-gray-500 dark:placeholder:text-gray-400 focus:border-blue-700 transition-colors"
                />
              </div>

              <div role="group" aria-labelledby="lang-label" className="space-y-2">
                <p id="lang-label" className="it-text text-base font-medium text-gray-800 dark:text-gray-200">
                  {t.interfaceLang}
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {LANGS.map(lang => (
                    <button
                      key={lang}
                      type="button"
                      lang={lang}
                      aria-pressed={studentLang === lang}
                      onClick={() => changeLang(lang)}
                      className={[
                        'it-choice py-2.5 rounded-xl text-sm font-medium transition-colors border-2',
                        studentLang === lang
                          ? 'bg-blue-700 border-blue-700 text-white'
                          : 'bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-600 text-gray-800 dark:text-gray-200 hover:border-blue-600',
                      ].join(' ')}
                    >
                      {LANG_NAMES[lang]}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <label htmlFor="code-input" className="it-text block text-base font-medium text-gray-800 dark:text-gray-200">
                  {t.lessonCode}
                </label>
                <input
                  id="code-input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={6}
                  value={codeInput}
                  onChange={e => { setCodeInput(e.target.value.replace(/\D/g, '')); setErrorKey(null); setErrorField(null) }}
                  placeholder="123456"
                  aria-invalid={errorField === 'code'}
                  aria-describedby={errorField === 'code' ? 'join-error code-hint' : 'code-hint'}
                  className="it-surface it-text it-border w-full text-4xl font-mono text-center py-4 px-4 border-2 border-gray-300 dark:border-gray-600 rounded-xl bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder:text-gray-400 dark:placeholder:text-gray-500 tracking-widest focus:border-blue-700 transition-colors"
                />
                <p id="code-hint" className="it-muted text-sm text-gray-600 dark:text-gray-300">{t.lessonCodeHint}</p>
              </div>

              <p id="join-error" role="alert" className="text-base font-medium text-red-700 dark:text-red-300 text-center min-h-6">
                {errorText}
              </p>

              <button
                type="submit"
                className="w-full py-4 bg-blue-700 hover:bg-blue-800 text-white text-lg font-semibold rounded-xl transition-colors"
              >
                {t.connect}
              </button>
            </form>
          )}
        </main>
        {settingsDialog}
      </div>
    )
  }

  // ── Connecting ─────────────────────────────────────────────────────────────
  if (state === 'connecting') {
    return (
      <div className="it-surface min-h-screen flex flex-col bg-white dark:bg-gray-950">
        <SiteHeader />
        <main id="main" className="flex-1 flex items-center justify-center">
          <div role="status" className="text-center space-y-3">
            <div aria-hidden="true" className="w-8 h-8 border-4 border-blue-700 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="it-text text-lg text-gray-700 dark:text-gray-200">{t.connecting}</p>
          </div>
        </main>
      </div>
    )
  }

  // ── Error ──────────────────────────────────────────────────────────────────
  if (state === 'error') {
    return (
      <div className="it-surface min-h-screen flex flex-col bg-white dark:bg-gray-950">
        <SiteHeader />
        <main id="main" className="flex-1 flex items-center justify-center px-4">
          <div className="text-center space-y-4 max-w-sm">
            <h1 className="it-text text-2xl font-semibold text-gray-900 dark:text-white">{t.error}</h1>
            <p role="alert" className="it-text text-lg text-gray-700 dark:text-gray-200">{errorKey ? t[errorKey] : ''}</p>
            <button
              onClick={retry}
              className="px-6 py-3 bg-blue-700 hover:bg-blue-800 text-white font-semibold rounded-xl transition-colors"
            >
              {t.retry}
            </button>
          </div>
        </main>
      </div>
    )
  }

  // ── Active lesson ──────────────────────────────────────────────────────────
  const captionLines = subtitles.filter(line => !line.note)
  const shownSubtitles = display.captionMode === 'last' ? captionLines.slice(-1) : subtitles
  const lastSignalLabel = lastSignal ? SIGNAL_LABELS[studentLang][lastSignal.type] : ''

  return (
    <div className="it-surface min-h-screen flex flex-col bg-white dark:bg-gray-950">
      <header className="it-surface it-border sticky top-0 z-10 flex items-center justify-between gap-2 px-4 py-2 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
        <div role="status" className="flex items-center gap-2 min-w-0">
          {lessonEnded ? (
            <span className="it-text text-sm font-medium text-gray-700 dark:text-gray-200">{t.lessonEnded}</span>
          ) : reconnecting ? (
            <>
              <span aria-hidden="true" className="w-2.5 h-2.5 rounded-full bg-amber-500 shrink-0" />
              <span className="it-text text-sm font-medium text-amber-800 dark:text-amber-300 truncate">{t.reconnecting}</span>
            </>
          ) : (
            <>
              <span aria-hidden="true" className="w-2.5 h-2.5 rounded-full bg-green-600 shrink-0" />
              <span className="it-text text-sm font-medium text-gray-800 dark:text-gray-200 truncate">
                {connectedName} · <span className="sr-only">{t.lesson} </span>{connectedCode}
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <SettingsButton t={t} onClick={() => setSettingsOpen(true)} />
          <ThemeToggle />
          <button
            onClick={leave}
            className="it-text it-border text-sm font-medium px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-800 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            {t.leave}
          </button>
        </div>
      </header>

      <main id="main" className="flex-1 flex flex-col">
        <h1 className="sr-only">{t.lesson} {connectedCode}</h1>

        <div role="status">
          {teacherReconnecting && !lessonEnded ? (
            <p className="it-surface it-text it-border px-4 py-2 text-center text-sm font-medium bg-amber-50 text-amber-900 border-b border-amber-200 dark:bg-amber-950/40 dark:text-amber-100 dark:border-amber-800">
              {t.teacherReconnecting}
            </p>
          ) : teacherMicOff && !lessonEnded ? (
            <p className="it-surface it-text it-border px-4 py-2 text-center text-sm font-medium bg-gray-100 text-gray-800 border-b border-gray-200 dark:bg-gray-800 dark:text-gray-100 dark:border-gray-700">
              <span aria-hidden="true">⏸ </span>{t.teacherMicOff}
            </p>
          ) : null}
        </div>

        <div className="flex-1 px-5 py-8" style={{ paddingBottom: panelHeight + 24 }}>
          {captionLines.length === 0 && !lessonEnded && (
            <p className="it-muted text-center text-gray-600 dark:text-gray-300 text-2xl mt-16">{t.waitingTeacher}</p>
          )}
          <div
            role="log"
            aria-live="polite"
            aria-atomic={display.captionMode === 'last'}
            aria-label={t.captionsLabel}
            lang={lessonLang}
            className={display.captionMode === 'last' ? 'min-h-[40vh] flex items-center' : 'space-y-6'}
          >
            {shownSubtitles.map((line, i) => line.note ? (
              <p key={i} lang={studentLang} className="it-muted text-center text-sm font-medium text-gray-600 dark:text-gray-300 py-1">
                — {t.lessonLangChanged.replace('{lang}', LANG_NAMES[line.lang])} —
              </p>
            ) : (
              <p
                key={display.captionMode === 'last' ? captionLines.length : i}
                lang={line.lang}
                className="it-caption font-medium text-gray-900 dark:text-white"
              >
                {line.text}
              </p>
            ))}
          </div>
          {lessonEnded && (
            <p className="it-muted it-border text-center text-gray-600 dark:text-gray-300 text-xl mt-6 pt-6 border-t border-gray-200 dark:border-gray-800">
              {t.lessonEnded}
            </p>
          )}
        </div>

        <div role="status" className="fixed top-16 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
          {gestureSent && (
            <p className="bg-violet-700 text-white px-4 py-3 rounded-xl shadow-xl text-sm font-medium">{t.gestureSent}</p>
          )}
        </div>
      </main>

      {unseenCaptions > 0 && display.captionMode === 'feed' && (
        <button
          onClick={scrollToLatest}
          style={{ bottom: panelHeight + 12 }}
          className="it-surface it-text it-border fixed left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-4 py-2.5 rounded-full shadow-lg border-2 border-blue-700 bg-white text-blue-800 font-semibold text-sm dark:bg-gray-900 dark:text-blue-200 dark:border-blue-400"
        >
          <span aria-hidden="true">↓</span>
          {t.newCaptions}: {unseenCaptions}
        </button>
      )}

      {/* Bottom panel: questions and quick signals */}
      <section
        ref={panelRef}
        aria-label={t.signalsLabel}
        className="it-surface it-border fixed bottom-0 left-0 right-0 z-40 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800"
      >
        {questionOpen && (
          <div className="it-border px-3 pt-3 pb-2 border-b border-gray-200 dark:border-gray-800">
            <div className="max-w-2xl mx-auto">
              <label htmlFor="question-input" className="sr-only">{t.questionLabel}</label>
              <textarea
                id="question-input"
                ref={textareaRef}
                value={questionText}
                onChange={e => {
                  setQuestionText(e.target.value)
                  const ta = e.target
                  ta.style.height = 'auto'
                  ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    sendQuestion()
                  }
                }}
                placeholder={t.questionPlaceholder}
                maxLength={MAX_QUESTION_LEN}
                rows={3}
                aria-describedby="question-hint"
                className="it-surface it-text it-border w-full bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white text-base rounded-xl px-4 py-3 resize-none border-2 border-transparent placeholder:text-gray-600 dark:placeholder:text-gray-300"
                style={{ minHeight: '80px', maxHeight: '160px' }}
              />
              <div className="flex items-center justify-between gap-2 mt-2">
                <span id="question-hint" className="it-muted text-xs text-gray-600 dark:text-gray-300">
                  {questionText.length} / {MAX_QUESTION_LEN} · {t.questionHint}
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => { setQuestionOpen(false); setQuestionText('') }}
                    className="it-text px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 hover:text-gray-900 dark:hover:text-white rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                  >
                    {t.cancel}
                  </button>
                  <button
                    onClick={sendQuestion}
                    disabled={!questionText.trim() || lessonEnded}
                    className="px-4 py-2 text-sm font-semibold bg-blue-700 hover:bg-blue-800 disabled:bg-gray-200 dark:disabled:bg-gray-700 disabled:text-gray-600 dark:disabled:text-gray-300 text-white rounded-lg transition-colors disabled:cursor-not-allowed"
                  >
                    {t.send}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Status row: undo / sent confirmations, otherwise question + gesture buttons */}
        <div className="it-border max-w-2xl mx-auto px-3 py-1.5 border-b border-gray-200 dark:border-gray-800">
          <div role="status" className="empty:hidden">
            {ackNotice ? (
              <p className="it-text py-2 text-center text-sm font-semibold text-green-800 dark:text-green-300">
                <span aria-hidden="true">✓ </span>{t.teacherSaw.replace('{what}', ackNotice)}
              </p>
            ) : lastSignal ? (
              <p className="flex items-center justify-center gap-3 py-1 text-sm font-medium text-gray-800 dark:text-gray-100 it-text">
                <span>{t.signalSentFull.replace('{label}', lastSignalLabel)}</span>
                <button
                  onClick={undoSignal}
                  className="it-text it-border px-3 py-1.5 rounded-lg border-2 border-gray-400 dark:border-gray-500 font-semibold hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                >
                  {t.undo}
                </button>
              </p>
            ) : undoNotice ? (
              <p className="it-text py-2 text-center text-sm font-medium text-gray-800 dark:text-gray-100">{t.signalUndone}</p>
            ) : questionSent ? (
              <p className="it-text py-2 text-center text-sm font-medium text-green-800 dark:text-green-300">
                <span aria-hidden="true">✓ </span>{t.sent}
              </p>
            ) : null}
          </div>
          {!ackNotice && !lastSignal && !undoNotice && !questionSent && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => { if (!lessonEnded) setQuestionOpen(v => !v) }}
                disabled={lessonEnded}
                aria-expanded={questionOpen}
                aria-controls="question-input"
                className="it-text flex-1 py-2 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-200 hover:text-gray-900 hover:bg-gray-100 dark:hover:text-white dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5"
              >
                <span aria-hidden="true">✍</span>
                {questionOpen ? t.collapse : t.writeQuestion}
              </button>
              <div aria-hidden="true" className="w-px h-5 bg-gray-300 dark:bg-gray-700 shrink-0" />
              <button
                onClick={() => { if (!lessonEnded) setGestureOpen(true) }}
                disabled={lessonEnded}
                className="it-text flex-1 py-2 rounded-lg text-sm font-medium text-violet-800 dark:text-violet-300 hover:bg-violet-50 dark:hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5"
              >
                <span aria-hidden="true">🤚</span>
                {t.gestures}
              </button>
            </div>
          )}
        </div>

        <div className="px-2 pt-1 pb-3">
          <div className="flex justify-end max-w-md mx-auto w-full">
            <button
              onClick={toggleCompactSignals}
              aria-controls="signal-buttons"
              className="it-text flex items-center gap-1 px-2 py-1 mb-1 rounded-md text-xs font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800 transition-colors"
            >
              <span aria-hidden="true">{compactSignals ? '▴' : '▾'}</span>
              {compactSignals ? t.biggerButtons : t.smallerButtons}
            </button>
          </div>
          <div
            id="signal-buttons"
            className={`grid gap-2 max-w-md mx-auto w-full ${compactSignals ? 'grid-cols-5 !gap-1' : 'grid-cols-2'}`}
          >
            {SIGNALS.map(({ type, icon, bg, activeBg }, idx) => {
              const justSent = lastSignal?.type === type && signalCooldown
              return (
                <button
                  key={type}
                  onClick={() => sendSignal(type)}
                  disabled={signalCooldown || lessonEnded}
                  aria-keyshortcuts={String(idx + 1)}
                  className={[
                    'it-signal relative flex flex-col items-center justify-center gap-1',
                    compactSignals ? 'min-h-[60px] px-0 rounded-lg' : 'min-h-[80px] rounded-xl',
                    'text-white font-semibold',
                    'transition-transform duration-100 active:scale-95',
                    bg, activeBg,
                    !compactSignals && idx === SIGNALS.length - 1 ? 'col-span-2' : '',
                    signalCooldown || lessonEnded ? 'opacity-70 cursor-not-allowed' : 'cursor-pointer',
                  ].join(' ')}
                >
                  {!compactSignals && (
                    <span aria-hidden="true" className="hidden md:block absolute top-1.5 left-2 text-xs font-bold opacity-90">{idx + 1}</span>
                  )}
                  <span aria-hidden="true" className={compactSignals ? 'text-xl leading-none' : 'text-3xl leading-none'}>{icon}</span>
                  <span className={compactSignals ? 'text-[11px] leading-tight text-center tracking-tight' : 'text-base leading-tight text-center px-1'}>
                    {justSent ? t.signalSent : SIGNAL_LABELS[studentLang][type]}
                  </span>
                </button>
              )
            })}
          </div>
          <p className="it-muted hidden md:block text-center text-xs text-gray-600 dark:text-gray-300 mt-2">{t.shortcutsHint}</p>
        </div>
      </section>

      {gestureOpen && (
        <GestureMockModal t={t} onClose={() => setGestureOpen(false)} onSendGesture={sendGesture} />
      )}
      {settingsDialog}
    </div>
  )
}
