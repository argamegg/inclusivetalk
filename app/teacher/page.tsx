'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import type { FeedbackItem, SignalType, StudentInfo } from '../types'
import SiteHeader from '../components/SiteHeader'
import { SIGNAL_LABELS } from '../i18n'
import { LANGS, LANG_NAMES, SIGNALS, WS_URL, MAX_RECONNECT_ATTEMPTS, reconnectDelay, type Lang } from '../constants'

type LessonState = 'idle' | 'connecting' | 'active' | 'stopped' | 'error'

const SPEECH_LOCALE: Record<Lang, string> = {
  ru: 'ru-RU',
  kk: 'kk-KZ',
  en: 'en-US',
}

const SIGNAL_CONFIG = Object.fromEntries(
  SIGNALS.map(s => [s.type, { icon: s.icon, bg: s.bg, label: SIGNAL_LABELS.ru[s.type] }]),
) as Record<SignalType, { icon: string; bg: string; label: string }>

const AVATAR_COLORS = [
  'bg-blue-500', 'bg-emerald-500', 'bg-violet-500', 'bg-amber-500', 'bg-rose-500',
]

function getAvatarColor(name: string): string {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) & 0xffffffff
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

function playBeep(): void {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.2, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.15)
  } catch { /* audio unavailable */ }
}

function formatTime(timestamp: number): string {
  const diffSec = Math.floor((Date.now() - timestamp) / 1000)
  if (diffSec < 60) return 'сейчас'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} мин назад`
  return `${Math.floor(diffSec / 3600)} ч назад`
}

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

function tokenStorageKey(code: string): string {
  return `inclusivetalk_teacher_token_${code}`
}

export default function TeacherPage() {
  const [state, setState] = useState<LessonState>('idle')
  const [language, setLanguage] = useState<Lang>('ru')
  const [code, setCode] = useState('')
  const [transcript, setTranscript] = useState('')
  const [connected, setConnected] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  const [signals, setSignals] = useState<FeedbackItem[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [toast, setToast] = useState<FeedbackItem | null>(null)
  const [signalPanelOpen, setSignalPanelOpen] = useState(false)

  const [students, setStudents] = useState<StudentInfo[]>([])
  const [studentPanelOpen, setStudentPanelOpen] = useState(false)
  const [joinToast, setJoinToast] = useState<{ name: string } | null>(null)

  const [, setTick] = useState(0)

  const wsRef = useRef<WebSocket | null>(null)
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const isLiveRef = useRef(false)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const joinToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptsRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const languageRef = useRef<Lang>('ru')
  // Used to call connectWs from within its own onclose without circular dep
  const connectWsRef = useRef<((roomCode: string, lang: Lang, token: string | null) => void) | null>(null)

  const stopRecognition = useCallback(() => {
    if (recognitionRef.current) {
      const r = recognitionRef.current
      recognitionRef.current = null
      r.onend = null
      r.onerror = null
      r.onresult = null
      try { r.stop() } catch { /* already stopped */ }
    }
  }, [])

  const closeWs = useCallback(() => {
    if (wsRef.current) {
      const ws = wsRef.current
      wsRef.current = null
      ws.onopen = null
      ws.onmessage = null
      ws.onclose = null
      ws.onerror = null
      ws.close()
    }
  }, [])

  const stopAll = useCallback(() => {
    isLiveRef.current = false
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    stopRecognition()
    closeWs()
  }, [stopRecognition, closeWs])

  useEffect(() => () => {
    stopAll()
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    if (joinToastTimerRef.current) clearTimeout(joinToastTimerRef.current)
  }, [stopAll])

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  const connectWs = useCallback((roomCode: string, lang: Lang, token: string | null) => {
    closeWs()
    const ws = new WebSocket(WS_URL)
    wsRef.current = ws

    ws.onopen = () => {
      const msg: Record<string, unknown> = {
        type: 'register',
        role: 'teacher',
        code: roomCode,
        language: lang,
      }
      if (token) msg.token = token
      ws.send(JSON.stringify(msg))
    }

    ws.onmessage = (event: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(event.data) as Record<string, unknown>

        if (msg.type === 'registered') {
          // Store/update teacher token in sessionStorage
          const teacherToken = String(msg.teacherToken ?? '')
          if (teacherToken) {
            try { sessionStorage.setItem(tokenStorageKey(roomCode), teacherToken) } catch { /* */ }
          }

          reconnectAttemptsRef.current = 0
          setReconnecting(false)
          setState('active')
          setConnected(true)

          const rawStudents = msg.students
          if (Array.isArray(rawStudents)) {
            setStudents(
              rawStudents.map((s: unknown) => {
                const sv = s as Record<string, unknown>
                return {
                  studentId: String(sv.studentId ?? ''),
                  name: String(sv.name ?? ''),
                  joinedAt: typeof sv.joinedAt === 'number' ? sv.joinedAt : Date.now(),
                }
              })
            )
          }

          // Start speech recognition only once (not on reconnect)
          if (!recognitionRef.current) {
            const SpeechAPI = window.SpeechRecognition ?? window.webkitSpeechRecognition
            if (!SpeechAPI) return
            isLiveRef.current = true

            const recognition = new SpeechAPI()
            recognition.lang = SPEECH_LOCALE[lang]
            recognition.continuous = true
            recognition.interimResults = true
            recognitionRef.current = recognition

            recognition.onresult = (evt: SpeechRecognitionEvent) => {
              for (let i = evt.resultIndex; i < evt.results.length; i++) {
                if (evt.results[i].isFinal) {
                  const text = evt.results[i][0].transcript.trim()
                  if (!text) continue
                  setTranscript(prev => prev + text + ' ')
                  if (wsRef.current?.readyState === WebSocket.OPEN) {
                    wsRef.current.send(JSON.stringify({ type: 'transcript', text }))
                  }
                }
              }
            }

            recognition.onerror = (evt: SpeechRecognitionErrorEvent) => {
              if (evt.error !== 'no-speech') console.log(`[Speech] Error: ${evt.error}`)
            }

            recognition.onend = () => {
              if (isLiveRef.current) {
                try { recognition.start() } catch { /* already restarting */ }
              }
            }

            recognition.start()
          }

        } else if (msg.type === 'error') {
          stopAll()
          setState('error')
          setErrorMsg(String(msg.message ?? 'Ошибка сервера'))

        } else if (msg.type === 'student_joined') {
          const name = String(msg.name ?? '')
          const studentId = String(msg.studentId ?? '')
          const joinedAt = typeof msg.joinedAt === 'number' ? msg.joinedAt : Date.now()
          setStudents(prev => [...prev, { studentId, name, joinedAt }])
          if (joinToastTimerRef.current) clearTimeout(joinToastTimerRef.current)
          setJoinToast({ name })
          joinToastTimerRef.current = setTimeout(() => setJoinToast(null), 2000)

        } else if (msg.type === 'student_left') {
          const studentId = String(msg.studentId ?? '')
          setStudents(prev => prev.filter(s => s.studentId !== studentId))

        } else if (msg.type === 'signal' || msg.type === 'question' || msg.type === 'gesture') {
          const base = {
            id: crypto.randomUUID(),
            timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
            studentId: String(msg.studentId ?? ''),
            studentName: String(msg.name ?? 'Студент'),
          }
          let item: FeedbackItem
          if (msg.type === 'signal') {
            const signalType = msg.signalType as SignalType
            if (!(signalType in SIGNAL_CONFIG)) return
            item = { ...base, kind: 'signal', signalType }
          } else if (msg.type === 'question') {
            const text = String(msg.text ?? '').trim()
            if (!text) return
            item = { ...base, kind: 'question', questionText: text }
          } else {
            const letter = String(msg.letter ?? '').trim()
            if (!letter) return
            item = { ...base, kind: 'gesture', gestureLetter: letter }
          }
          setSignals(prev => [item, ...prev].slice(0, 10))
          setUnreadCount(prev => prev + 1)
          if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
          setToast(item)
          toastTimerRef.current = setTimeout(() => setToast(null), 3000)
          playBeep()
        }
      } catch { /* ignore malformed */ }
    }

    ws.onclose = () => {
      setConnected(false)
      if (wsRef.current !== ws) return  // we already moved on (closeWs called)
      wsRef.current = null

      if (!isLiveRef.current) return    // user stopped the lesson

      // Attempt reconnect with exponential backoff
      reconnectAttemptsRef.current += 1
      if (reconnectAttemptsRef.current > MAX_RECONNECT_ATTEMPTS) {
        stopAll()
        setState('error')
        setErrorMsg('Соединение с сервером прервано после нескольких попыток')
        return
      }

      setReconnecting(true)
      const savedToken = sessionStorage.getItem(tokenStorageKey(roomCode)) ?? null
      reconnectTimerRef.current = setTimeout(() => {
        if (isLiveRef.current) connectWsRef.current?.(roomCode, languageRef.current, savedToken)
      }, reconnectDelay(reconnectAttemptsRef.current))
    }

    ws.onerror = () => { /* onclose handles it */ }
  }, [closeWs, stopAll])

  // Keep ref in sync so onclose can call connectWs without circular dep
  useEffect(() => {
    connectWsRef.current = connectWs
  }, [connectWs])

  const startLesson = useCallback(() => {
    const SpeechAPI = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!SpeechAPI) {
      setState('error')
      setErrorMsg('Используйте Chrome или Edge — ваш браузер не поддерживает Web Speech API')
      return
    }

    const roomCode = generateCode()
    languageRef.current = language
    setCode(roomCode)
    setTranscript('')
    setConnected(false)
    setReconnecting(false)
    setSignals([])
    setUnreadCount(0)
    setToast(null)
    setSignalPanelOpen(false)
    setStudents([])
    setStudentPanelOpen(false)
    setJoinToast(null)
    reconnectAttemptsRef.current = 0
    setState('connecting')

    connectWs(roomCode, language, null)
  }, [language, connectWs])

  const stopLesson = useCallback(() => {
    stopAll()
    setConnected(false)
    setReconnecting(false)
    setState('stopped')
  }, [stopAll])

  const retry = useCallback(() => {
    stopAll()
    setState('idle')
    setCode('')
    setTranscript('')
    setErrorMsg('')
    setSignals([])
    setUnreadCount(0)
    setToast(null)
    setStudents([])
    setJoinToast(null)
    setReconnecting(false)
  }, [stopAll])

  const copyCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard unavailable */ }
  }, [code])

  const clearSignals = useCallback(() => {
    setSignals([])
    setUnreadCount(0)
  }, [])

  // ── Idle / Stopped ─────────────────────────────────────────────────────────
  if (state === 'idle' || state === 'stopped') {
    return (
      <div className="min-h-screen flex flex-col bg-white dark:bg-gray-950">
        <SiteHeader />
        <main className="flex-1 flex items-center justify-center px-4">
          <div className="text-center space-y-6">
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Преподаватель</h1>
            <div className="space-y-2">
              <p className="text-sm text-gray-500 dark:text-gray-400">Язык урока</p>
              <div className="flex flex-col sm:flex-row gap-2 justify-center">
                {LANGS.map(lang => (
                  <button
                    key={lang}
                    onClick={() => setLanguage(lang)}
                    className={`px-5 py-2 rounded-xl text-sm font-medium transition-colors ${
                      language === lang
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-100 hover:bg-gray-200 text-gray-400 dark:bg-gray-800 dark:hover:bg-gray-700 dark:text-gray-500'
                    }`}
                  >
                    {LANG_NAMES[lang]}
                  </button>
                ))}
              </div>
            </div>
            <button
              onClick={startLesson}
              className="block mx-auto px-10 py-4 bg-blue-600 hover:bg-blue-700 text-white text-lg font-medium rounded-2xl transition-colors"
            >
              Начать урок
            </button>
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
            <p className="text-xl font-semibold text-red-600">Ошибка</p>
            <p className="text-gray-500 dark:text-gray-400">{errorMsg}</p>
            <button
              onClick={retry}
              className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl transition-colors"
            >
              Попробовать снова
            </button>
          </div>
        </main>
      </div>
    )
  }

  // ── Active — shared sub-components ────────────────────────────────────────

  const studentListContent = (
    <>
      {students.length === 0 ? (
        <p className="text-center text-gray-400 dark:text-gray-500 text-sm py-6 px-4">
          Пока никого. Поделитесь кодом урока.
        </p>
      ) : (
        students.map(student => (
          <div key={student.studentId} className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-800 last:border-0">
            <span className={`w-8 h-8 flex items-center justify-center rounded-full text-white text-sm font-bold shrink-0 ${getAvatarColor(student.name)}`}>
              {student.name.charAt(0).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{student.name}</p>
                <span className="w-1.5 h-1.5 bg-green-500 rounded-full shrink-0" />
              </div>
              <p className="text-xs text-gray-400">присоединился {formatTime(student.joinedAt)}</p>
            </div>
          </div>
        ))
      )}
    </>
  )

  const signalListContent = (
    <>
      {signals.length === 0 ? (
        <p className="text-center text-gray-400 dark:text-gray-500 text-sm py-8 px-4">
          Нет сигналов
        </p>
      ) : (
        signals.map(item => {
          if (item.kind === 'question') {
            return (
              <div key={item.id} className="flex gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-800 last:border-0">
                <span className="w-8 h-8 flex items-center justify-center rounded-full bg-blue-600 text-white text-sm shrink-0">✍</span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-1 font-medium">{item.studentName}</p>
                  <p className="text-sm text-gray-800 dark:text-gray-200 leading-relaxed break-words whitespace-pre-wrap">«{item.questionText}»</p>
                  <p className="text-xs text-gray-400 mt-1">{formatTime(item.timestamp)}</p>
                </div>
              </div>
            )
          }
          if (item.kind === 'gesture') {
            return (
              <div key={item.id} className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-800 last:border-0">
                <span className="w-8 h-8 flex items-center justify-center rounded-full bg-violet-600 text-white text-sm shrink-0">🤚</span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{item.studentName}: показал жест «{item.gestureLetter}»</p>
                  <p className="text-xs text-gray-400">{formatTime(item.timestamp)}</p>
                </div>
              </div>
            )
          }
          const cfg = SIGNAL_CONFIG[item.signalType!]
          return (
            <div key={item.id} className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-800 last:border-0">
              <span className={`w-8 h-8 flex items-center justify-center rounded-full text-white text-sm shrink-0 ${cfg.bg}`}>{cfg.icon}</span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{item.studentName}: {cfg.label}</p>
                <p className="text-xs text-gray-400">{formatTime(item.timestamp)}</p>
              </div>
            </div>
          )
        })
      )}
    </>
  )

  // ── Active ─────────────────────────────────────────────────────────────────
  const statusDot = connected ? 'bg-green-500' : 'bg-yellow-400'
  const statusText = connected
    ? 'Подключено'
    : state === 'connecting'
    ? 'Подключение...'
    : reconnecting
    ? 'Переподключение...'
    : 'Нет связи'

  return (
    <div className="min-h-screen flex flex-col">
      <SiteHeader>
        <button
          onClick={stopLesson}
          className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          Завершить урок
        </button>
      </SiteHeader>
      <div className="flex flex-1 min-h-0">
        <main className="flex-1 min-w-0 flex flex-col px-4 py-6 bg-white dark:bg-gray-950">

          <div className="bg-gray-50 dark:bg-gray-900 rounded-2xl p-6 mb-6 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Код урока</span>
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full transition-colors ${statusDot}`} />
                <span className="text-sm text-gray-600 dark:text-gray-300">{statusText}</span>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <span className="text-5xl font-mono font-bold text-gray-900 dark:text-white tracking-widest">{code}</span>
              <button
                onClick={copyCode}
                className="px-3 py-1.5 text-sm bg-blue-100 hover:bg-blue-200 dark:bg-blue-900/40 dark:hover:bg-blue-900/70 text-blue-700 dark:text-blue-300 rounded-lg transition-colors"
              >
                {copied ? '✓ Скопировано' : 'Копировать'}
              </button>
            </div>

            {state === 'active' && (
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-red-500">
                  <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                  <span className="text-sm font-medium">Идёт запись</span>
                </div>
                <p className="text-xs text-gray-400 pl-4">Язык: {LANG_NAMES[language]}</p>
              </div>
            )}
          </div>

          <div className="flex-1 bg-gray-50 dark:bg-gray-900 rounded-2xl p-6 min-h-64">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">Транскрипт</p>
            {transcript ? (
              <p className="text-gray-800 dark:text-gray-200 text-lg leading-relaxed whitespace-pre-wrap">{transcript}</p>
            ) : (
              <p className="text-gray-400 italic">Говорите — текст появится здесь...</p>
            )}
          </div>
        </main>

        {/* Desktop right sidebar */}
        <aside className="hidden md:flex w-72 shrink-0 flex-col bg-gray-50 dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700">
          <div className="flex flex-col" style={{ maxHeight: '40%' }}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
              <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">Студенты в классе</span>
              <span className="bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-xs font-bold rounded-full px-2 py-0.5 min-w-[22px] text-center">
                {students.length}
              </span>
            </div>
            <div className="overflow-y-auto flex-1">{studentListContent}</div>
          </div>

          <div className="border-t border-gray-200 dark:border-gray-700 shrink-0" />

          <div className="flex flex-col flex-1 min-h-0">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
              <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">Сигналы</span>
              {unreadCount > 0 && (
                <span className="bg-blue-600 text-white text-xs font-bold rounded-full px-2 py-0.5 min-w-[22px] text-center">
                  {unreadCount}
                </span>
              )}
            </div>
            <div className="flex-1 overflow-y-auto">{signalListContent}</div>
            <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 shrink-0">
              <button
                onClick={clearSignals}
                className="w-full text-sm text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 transition-colors py-1"
              >
                Очистить
              </button>
            </div>
          </div>
        </aside>
      </div>

      {/* Mobile: students floating button */}
      <div className="md:hidden fixed bottom-4 left-4 z-40">
        <button
          onClick={() => { setStudentPanelOpen(v => !v); setSignalPanelOpen(false) }}
          className="flex items-center gap-2 px-4 py-3 bg-gray-700 hover:bg-gray-600 text-white font-medium rounded-full shadow-lg transition-colors"
        >
          <span>👥</span>
          <span className="text-sm">Студенты{students.length > 0 ? ` (${students.length})` : ''}</span>
        </button>
      </div>

      {studentPanelOpen && (
        <div className="md:hidden fixed bottom-16 left-0 right-0 z-30 bg-white dark:bg-gray-900 rounded-t-2xl border-t border-gray-200 dark:border-gray-700 shadow-2xl max-h-72 flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800 shrink-0">
            <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">
              Студенты в классе
              <span className="ml-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-xs font-bold rounded-full px-2 py-0.5">
                {students.length}
              </span>
            </span>
            <button onClick={() => setStudentPanelOpen(false)} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-lg leading-none">✕</button>
          </div>
          <div className="flex-1 overflow-y-auto">{studentListContent}</div>
        </div>
      )}

      {/* Mobile: signals floating button */}
      <div className="md:hidden fixed bottom-4 right-4 z-40">
        <button
          onClick={() => { setSignalPanelOpen(v => !v); setStudentPanelOpen(false) }}
          className="flex items-center gap-2 px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-full shadow-lg transition-colors"
        >
          <span>📥</span>
          <span className="text-sm">Сигналы{unreadCount > 0 ? ` (${unreadCount})` : ''}</span>
        </button>
      </div>

      {signalPanelOpen && (
        <div className="md:hidden fixed bottom-16 left-0 right-0 z-30 bg-white dark:bg-gray-900 rounded-t-2xl border-t border-gray-200 dark:border-gray-700 shadow-2xl max-h-72 flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800 shrink-0">
            <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">
              Сигналы от студентов
              {unreadCount > 0 && (
                <span className="ml-2 bg-blue-600 text-white text-xs font-bold rounded-full px-2 py-0.5">{unreadCount}</span>
              )}
            </span>
            <button onClick={() => setSignalPanelOpen(false)} className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-lg leading-none">✕</button>
          </div>
          <div className="flex-1 overflow-y-auto">{signalListContent}</div>
          <div className="px-4 py-3 border-t border-gray-100 dark:border-gray-800 shrink-0">
            <button
              onClick={() => { clearSignals(); setSignalPanelOpen(false) }}
              className="w-full text-sm text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
            >
              Очистить
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div
          role="alert"
          onClick={() => setToast(null)}
          className={[
            'fixed top-4 right-4 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-xl cursor-pointer max-w-xs text-white',
            toast.kind === 'question'
              ? 'bg-blue-600'
              : toast.kind === 'gesture'
              ? 'bg-violet-600'
              : SIGNAL_CONFIG[toast.signalType!].bg,
          ].join(' ')}
        >
          <span className="text-xl shrink-0">
            {toast.kind === 'question' ? '✍' : toast.kind === 'gesture' ? '🤚' : SIGNAL_CONFIG[toast.signalType!].icon}
          </span>
          <div className="min-w-0">
            <p className="font-medium text-sm leading-snug break-words">
              {toast.kind === 'question'
                ? `${toast.studentName}: ${toast.questionText!.length > 45 ? toast.questionText!.slice(0, 45) + '…' : toast.questionText}`
                : toast.kind === 'gesture'
                ? `${toast.studentName}: жест «${toast.gestureLetter}»`
                : `${toast.studentName}: ${SIGNAL_CONFIG[toast.signalType!].label}`}
            </p>
          </div>
        </div>
      )}

      {joinToast && (
        <div className="fixed bottom-20 left-4 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-xl bg-gray-800 text-white max-w-xs md:bottom-4">
          <span className="text-lg">👋</span>
          <p className="text-sm font-medium">{joinToast.name} присоединился</p>
        </div>
      )}
    </div>
  )
}
