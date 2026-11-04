'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import type { SignalType } from '../types'
import ThemeToggle from '../components/ThemeToggle'
import GestureMockModal from '../components/GestureMockModal'
import SiteHeader from '../components/SiteHeader'
import { useMounted } from '../useMounted'
import { SIGNAL_LABELS, UI_LABELS } from '../i18n'
import { LANGS, LANG_NAMES, SIGNALS, WS_URL, MAX_RECONNECT_ATTEMPTS, reconnectDelay, type Lang } from '../constants'

type StudentState = 'idle' | 'connecting' | 'active' | 'error'

const LS_NAME_KEY = 'inclusivetalk_student_name'
const LS_LANG_KEY = 'inclusivetalk_student_lang'

const MAX_SUBTITLES = 200
const MAX_QUESTION_LEN = 500

export default function StudentPage() {
  // Name and language come from localStorage, so the form renders only after hydration
  const mounted = useMounted()
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
  const [subtitles, setSubtitles] = useState<string[]>([])
  const [errorMsg, setErrorMsg] = useState('')
  const [lessonEnded, setLessonEnded] = useState(false)

  const [reconnecting, setReconnecting] = useState(false)
  const [teacherReconnecting, setTeacherReconnecting] = useState(false)

  const [signalCooldown, setSignalCooldown] = useState(false)
  const [lastSignal, setLastSignal] = useState<SignalType | null>(null)

  const [questionOpen, setQuestionOpen] = useState(false)
  const [questionText, setQuestionText] = useState('')
  const [questionSent, setQuestionSent] = useState(false)
  const [questionCooldown, setQuestionCooldown] = useState(false)

  const [gestureOpen, setGestureOpen] = useState(false)
  const [gestureToast, setGestureToast] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const stateRef = useRef<StudentState>('idle')
  const lessonEndedRef = useRef(false)
  const userDisconnectedRef = useRef(false)
  const subtitlesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const reconnectAttemptsRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const savedCodeRef = useRef('')
  const savedNameRef = useRef('')
  const connectWsRef = useRef<((code: string, name: string) => void) | null>(null)

  const setStateSynced = useCallback((s: StudentState) => {
    stateRef.current = s
    setState(s)
  }, [])

  useEffect(() => {
    subtitlesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [subtitles])

  useEffect(() => () => {
    wsRef.current?.close()
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
  }, [])

  const resetQuestionState = useCallback(() => {
    setQuestionOpen(false)
    setQuestionText('')
    setQuestionSent(false)
    setQuestionCooldown(false)
    setGestureOpen(false)
    setGestureToast(false)
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }, [])

  const changeLang = useCallback((lang: Lang) => {
    setStudentLang(lang)
    try { localStorage.setItem(LS_LANG_KEY, lang) } catch { /* */ }
  }, [])

  const connectWs = useCallback((code: string, name: string) => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }

    const ws = new WebSocket(WS_URL)
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'register', role: 'student', code, name }))
    }

    ws.onmessage = (event: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(event.data) as Record<string, unknown>

        if (msg.type === 'joined') {
          try { localStorage.setItem(LS_NAME_KEY, name) } catch { /* */ }
          reconnectAttemptsRef.current = 0
          setReconnecting(false)
          setStateSynced('active')

        } else if (msg.type === 'error') {
          setErrorMsg(String(msg.message ?? 'Ошибка подключения'))
          setStateSynced('error')
          ws.onclose = null
          ws.close()
          wsRef.current = null

        } else if (msg.type === 'transcript') {
          const text = String(msg.text ?? '')
          setSubtitles(prev => [...prev, text].slice(-MAX_SUBTITLES))

        } else if (msg.type === 'room_closed') {
          lessonEndedRef.current = true
          setLessonEnded(true)
          setReconnecting(false)
          setTeacherReconnecting(false)

        } else if (msg.type === 'teacher_disconnected') {
          setTeacherReconnecting(true)

        } else if (msg.type === 'teacher_reconnected') {
          setTeacherReconnecting(false)
        }

      } catch { /* ignore malformed */ }
    }

    ws.onclose = () => {
      if (wsRef.current !== ws) return  // we already moved on
      wsRef.current = null

      if (lessonEndedRef.current || userDisconnectedRef.current) return
      if (stateRef.current !== 'active' && stateRef.current !== 'connecting') return

      // Attempt reconnect
      reconnectAttemptsRef.current += 1
      if (reconnectAttemptsRef.current > MAX_RECONNECT_ATTEMPTS) {
        const m = stateRef.current === 'connecting'
          ? 'Не удалось подключиться к серверу'
          : 'Соединение прервано после нескольких попыток'
        setStateSynced('error')
        setErrorMsg(m)
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
  }, [setStateSynced])

  useEffect(() => {
    connectWsRef.current = connectWs
  }, [connectWs])

  const connect = useCallback(() => {
    const name = nameInput.trim()
    if (!name) {
      setErrorMsg('Введите ваше имя')
      return
    }
    if (!/^\d{6}$/.test(codeInput)) {
      setErrorMsg('Введите код урока (6 цифр)')
      return
    }
    setErrorMsg('')
    setStateSynced('connecting')
    setSubtitles([])
    setSignalCooldown(false)
    setLastSignal(null)
    resetQuestionState()
    lessonEndedRef.current = false
    userDisconnectedRef.current = false
    setLessonEnded(false)
    setReconnecting(false)
    setTeacherReconnecting(false)
    reconnectAttemptsRef.current = 0

    savedCodeRef.current = codeInput
    savedNameRef.current = name
    setConnectedCode(codeInput)
    setConnectedName(name)

    connectWs(codeInput, name)
  }, [nameInput, codeInput, setStateSynced, resetQuestionState, connectWs])

  const disconnect = useCallback(() => {
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
    stateRef.current = 'idle'
    setState('idle')
    setSubtitles([])
    setConnectedCode('')
    setConnectedName('')
    setSignalCooldown(false)
    setLastSignal(null)
    resetQuestionState()
    lessonEndedRef.current = false
    setLessonEnded(false)
    setReconnecting(false)
    setTeacherReconnecting(false)
  }, [resetQuestionState])

  const retry = useCallback(() => {
    userDisconnectedRef.current = false
    stateRef.current = 'idle'
    setState('idle')
    setErrorMsg('')
    setSignalCooldown(false)
    setLastSignal(null)
    resetQuestionState()
    setReconnecting(false)
    setTeacherReconnecting(false)
  }, [resetQuestionState])

  const sendSignal = useCallback((signalType: SignalType) => {
    if (signalCooldown || lessonEnded || !wsRef.current) return
    if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(100)
    setSignalCooldown(true)
    setLastSignal(signalType)
    wsRef.current.send(JSON.stringify({ type: 'signal', signalType }))
    setTimeout(() => {
      setSignalCooldown(false)
      setLastSignal(null)
    }, 2000)
  }, [signalCooldown, lessonEnded])

  const sendQuestion = useCallback(() => {
    const text = questionText.trim()
    if (!text || questionCooldown || lessonEnded || !wsRef.current) return
    wsRef.current.send(JSON.stringify({ type: 'question', text }))
    setQuestionText('')
    setQuestionOpen(false)
    setQuestionSent(true)
    setQuestionCooldown(true)
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    setTimeout(() => {
      setQuestionSent(false)
      setQuestionCooldown(false)
    }, 3000)
  }, [questionText, questionCooldown, lessonEnded])

  const sendGesture = useCallback((letter: string) => {
    if (!wsRef.current || lessonEnded) return
    wsRef.current.send(JSON.stringify({ type: 'gesture', letter }))
    setGestureToast(true)
    setTimeout(() => setGestureToast(false), 3000)
  }, [lessonEnded])

  const t = UI_LABELS[studentLang]

  // ── Idle ───────────────────────────────────────────────────────────────────
  if (state === 'idle') {
    const canConnect = nameInput.trim().length > 0 && codeInput.length === 6
    return (
      <div className="min-h-screen flex flex-col bg-white dark:bg-gray-950">
        <SiteHeader />
        <main className="flex-1 flex items-center justify-center px-4">
          {mounted && <div className="w-full max-w-sm space-y-6">
            <div className="text-center">
              <h1 className="text-3xl font-bold text-gray-900 dark:text-white">{t.student}</h1>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="name-input" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t.yourName}
                </label>
                <input
                  id="name-input"
                  type="text"
                  maxLength={50}
                  value={nameInput}
                  onChange={e => { setNameInput(e.target.value); setErrorMsg('') }}
                  onKeyDown={e => e.key === 'Enter' && connect()}
                  placeholder={t.nameExample}
                  className="w-full text-xl py-3 px-4 border-2 border-gray-200 dark:border-gray-700 rounded-xl bg-white dark:bg-gray-900 text-gray-900 dark:text-white focus:outline-none focus:border-blue-500 transition-colors"
                  autoComplete="name"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Язык интерфейса
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {LANGS.map(lang => (
                    <button
                      key={lang}
                      onClick={() => changeLang(lang)}
                      className={[
                        'py-2.5 rounded-xl text-sm font-medium transition-colors border-2',
                        studentLang === lang
                          ? 'bg-blue-600 border-blue-600 text-white'
                          : 'bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-blue-400 dark:hover:border-blue-500',
                      ].join(' ')}
                    >
                      {LANG_NAMES[lang]}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <label htmlFor="code-input" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t.lessonCode}
                </label>
                <input
                  id="code-input"
                  type="tel"
                  inputMode="numeric"
                  maxLength={6}
                  value={codeInput}
                  onChange={e => { setCodeInput(e.target.value.replace(/\D/g, '')); setErrorMsg('') }}
                  onKeyDown={e => e.key === 'Enter' && connect()}
                  placeholder="123456"
                  className="w-full text-4xl font-mono text-center py-4 px-4 border-2 border-gray-200 dark:border-gray-700 rounded-xl bg-white dark:bg-gray-900 text-gray-900 dark:text-white tracking-widest focus:outline-none focus:border-blue-500 transition-colors"
                />
              </div>

              {errorMsg && (
                <p className="text-sm text-red-600 text-center">{errorMsg}</p>
              )}

              <button
                onClick={connect}
                disabled={!canConnect}
                className="w-full py-4 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-200 dark:disabled:bg-gray-700 disabled:cursor-not-allowed disabled:text-gray-400 text-white text-lg font-medium rounded-xl transition-colors"
              >
                {t.connect}
              </button>
            </div>
          </div>}
        </main>
      </div>
    )
  }

  // ── Connecting ─────────────────────────────────────────────────────────────
  if (state === 'connecting') {
    return (
      <div className="min-h-screen flex flex-col bg-white dark:bg-gray-950">
        <SiteHeader />
        <main className="flex-1 flex items-center justify-center bg-white dark:bg-gray-950">
          <div className="text-center space-y-3">
            <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
            <p className="text-gray-500 dark:text-gray-400">{t.connecting}</p>
          </div>
        </main>
      </div>
    )
  }

  // ── Error ──────────────────────────────────────────────────────────────────
  if (state === 'error') {
    return (
      <div className="min-h-screen flex flex-col bg-white dark:bg-gray-950">
        <SiteHeader />
        <main className="flex-1 flex items-center justify-center px-4">
          <div className="text-center space-y-4 max-w-sm">
            <p className="text-xl font-semibold text-red-600">{t.error}</p>
            <p className="text-gray-500 dark:text-gray-400">{errorMsg}</p>
            <button
              onClick={retry}
              className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl transition-colors"
            >
              {t.retry}
            </button>
          </div>
        </main>
      </div>
    )
  }

  // ── Active ─────────────────────────────────────────────────────────────────
  const bottomPadding = questionOpen ? 280 : 130

  return (
    <main className="min-h-screen flex flex-col bg-white dark:bg-gray-950">
      <header className="sticky top-0 flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 z-10">
        <div className="flex items-center gap-2 min-w-0">
          {lessonEnded ? (
            <span className="text-sm text-gray-500 dark:text-gray-400 font-medium">{t.lessonEnded}</span>
          ) : reconnecting ? (
            <>
              <span className="w-2.5 h-2.5 bg-yellow-400 rounded-full animate-pulse shrink-0" />
              <span className="text-sm text-yellow-600 dark:text-yellow-400 font-medium truncate">{t.reconnecting}</span>
            </>
          ) : (
            <>
              <span className="w-2.5 h-2.5 bg-green-500 rounded-full animate-pulse shrink-0" />
              <span className="text-sm text-gray-700 dark:text-gray-300 font-medium truncate">
                {connectedName} · #{connectedCode}
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0 ml-2">
          <ThemeToggle />
          <button
            onClick={disconnect}
            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors px-3 py-1 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            {t.disconnect}
          </button>
        </div>
      </header>

      {/* Teacher reconnecting banner */}
      {teacherReconnecting && !lessonEnded && (
        <div className="sticky top-[53px] z-10 bg-yellow-50 dark:bg-yellow-900/20 border-b border-yellow-200 dark:border-yellow-800 px-4 py-2 text-center">
          <span className="text-sm text-yellow-700 dark:text-yellow-400 font-medium">
            {t.teacherReconnecting}
          </span>
        </div>
      )}

      <div
        className="flex-1 overflow-y-auto px-5 py-8 space-y-6"
        style={{ paddingBottom: `${bottomPadding}px` }}
      >
        {subtitles.length === 0 && !lessonEnded && (
          <p className="text-center text-gray-500 text-2xl mt-16">
            {t.waitingTeacher}
          </p>
        )}
        {subtitles.map((line, i) => (
          <p key={i} className="text-3xl md:text-4xl font-medium leading-relaxed text-gray-900 dark:text-white">
            {line}
          </p>
        ))}
        {lessonEnded && (
          <p className="text-center text-gray-500 text-xl pt-6 border-t border-gray-200 dark:border-gray-800">
            — {t.lessonEnded} —
          </p>
        )}
        <div ref={subtitlesEndRef} />
      </div>

      {/* Fixed bottom panel */}
      <div className="fixed bottom-0 left-0 right-0 z-40 bg-white/95 dark:bg-gray-900/95 backdrop-blur-sm border-t border-gray-200 dark:border-gray-800">

        {questionOpen && (
          <div className="px-3 pt-3 pb-2 border-b border-gray-200 dark:border-gray-800">
            <div className="max-w-2xl mx-auto">
              <textarea
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
                className="w-full bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white text-base rounded-xl px-4 py-3 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-400 dark:placeholder-gray-500"
                style={{ minHeight: '80px', maxHeight: '160px' }}
              />
              <div className="flex items-center justify-between mt-2">
                <span className="text-xs text-gray-500">{questionText.length} / {MAX_QUESTION_LEN}</span>
                <div className="flex gap-2">
                  <button
                    onClick={() => { setQuestionOpen(false); setQuestionText('') }}
                    className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
                  >
                    {t.cancel}
                  </button>
                  <button
                    onClick={sendQuestion}
                    disabled={!questionText.trim() || questionCooldown || lessonEnded}
                    className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:bg-gray-200 dark:disabled:bg-gray-700 disabled:text-gray-400 dark:disabled:text-gray-500 text-white rounded-lg transition-colors disabled:cursor-not-allowed"
                  >
                    {t.send}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="max-w-2xl mx-auto px-3 py-2 border-b border-gray-200 dark:border-gray-800">
          {questionSent ? (
            <p className="text-center text-sm text-green-600 dark:text-green-400 font-medium py-0.5">
              ✅ {t.sent}
            </p>
          ) : (
            <div className="flex items-center gap-1">
              <button
                onClick={() => { if (!lessonEnded) setQuestionOpen(v => !v) }}
                disabled={lessonEnded}
                className="flex-1 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors py-0.5 flex items-center justify-center gap-1.5"
              >
                {questionOpen ? t.collapse : t.writeQuestion}
              </button>
              <div className="w-px h-4 bg-gray-300 dark:bg-gray-700 shrink-0" />
              <button
                onClick={() => { if (!lessonEnded) setGestureOpen(true) }}
                disabled={lessonEnded}
                title="Прототип интерфейса жестового перевода"
                className="flex-1 text-sm text-violet-600 dark:text-violet-400 hover:text-violet-800 dark:hover:text-violet-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors py-0.5 flex items-center justify-center gap-1"
              >
                🤚 Жесты (демо)
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-col px-2 py-2 pb-6">
          <div className="grid grid-cols-2 gap-2 max-w-md mx-auto w-full">
            {SIGNALS.map(({ type, icon, bg, activeBg }, idx) => {
              const sent = lastSignal === type
              const isLast = idx === SIGNALS.length - 1
              return (
                <button
                  key={type}
                  onClick={() => sendSignal(type)}
                  disabled={signalCooldown || lessonEnded}
                  className={[
                    'flex flex-col items-center justify-center gap-0.5',
                    'min-h-[88px] h-full rounded-xl text-white font-semibold',
                    'transition-transform duration-100 active:scale-95',
                    bg,
                    activeBg,
                    isLast ? 'col-span-2' : '',
                    signalCooldown || lessonEnded ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer',
                  ].join(' ')}
                >
                  <span className="text-4xl leading-none">{icon}</span>
                  <span className="text-base leading-tight text-center px-1">
                    {sent ? t.signalSent : SIGNAL_LABELS[studentLang][type]}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {gestureToast && (
        <div
          role="status"
          className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-violet-600 text-white px-4 py-3 rounded-xl shadow-xl text-sm font-medium pointer-events-none"
        >
          🤚 Жест отправлен преподавателю
        </div>
      )}

      {gestureOpen && (
        <GestureMockModal
          onClose={() => setGestureOpen(false)}
          onSendGesture={sendGesture}
        />
      )}
    </main>
  )
}
