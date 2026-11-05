'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import type { FeedbackItem, SignalType, StudentInfo } from '../types'
import SiteHeader from '../components/SiteHeader'
import Dialog from '../components/Dialog'
import { useWakeLock } from '../useWakeLock'
import { useMounted } from '../useMounted'
import { SIGNAL_LABELS } from '../i18n'
import { LANGS, LANG_NAMES, SIGNALS, getWsUrl, MAX_RECONNECT_ATTEMPTS, reconnectDelay, makeId, type Lang } from '../constants'

type LessonState = 'idle' | 'connecting' | 'active' | 'stopped' | 'error'

const SPEECH_LOCALE: Record<Lang, string> = {
  ru: 'ru-RU',
  kk: 'kk-KZ',
  en: 'en-US',
}

const SIGNAL_CONFIG = Object.fromEntries(
  SIGNALS.map(s => [s.type, { icon: s.icon, bg: s.bg, label: SIGNAL_LABELS.ru[s.type] }]),
) as Record<SignalType, { icon: string; bg: string; label: string }>

// -700 shades keep the white initial readable (WCAG AA)
const AVATAR_COLORS = [
  'bg-blue-700', 'bg-emerald-700', 'bg-violet-700', 'bg-amber-700', 'bg-rose-700',
]

const LS_SOUND_KEY = 'inclusivetalk_teacher_sound'

// Speech errors that mean "the microphone can't be used" — shown to the teacher in plain words
const MIC_ERRORS: Record<string, string> = {
  'not-allowed': 'Браузер не дал доступ к микрофону. Нажмите на значок замка в адресной строке, разрешите микрофон и включите его снова.',
  'service-not-allowed': 'Браузер не дал доступ к распознаванию речи. Разрешите микрофон для этого сайта и включите его снова.',
  'audio-capture': 'Микрофон не найден. Подключите микрофон и включите его снова.',
}
const TOAST_MS = 8_000

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

function feedbackText(item: FeedbackItem): string {
  if (item.kind === 'question') return `${item.studentName}: «${item.questionText}»`
  if (item.kind === 'gesture') return `${item.studentName}: жест «${item.gestureLetter}»`
  return `${item.studentName}: ${SIGNAL_CONFIG[item.signalType!].label}`
}

function FeedbackIcon({ item }: { item: FeedbackItem }) {
  const [icon, bg] = item.kind === 'question' ? ['✍', 'bg-blue-700']
    : item.kind === 'gesture' ? ['🤚', 'bg-violet-700']
    : [SIGNAL_CONFIG[item.signalType!].icon, SIGNAL_CONFIG[item.signalType!].bg]
  return (
    <span aria-hidden="true" className={`w-8 h-8 flex items-center justify-center rounded-full text-white text-sm shrink-0 ${bg}`}>
      {icon}
    </span>
  )
}

// ── Saved lesson: survives a page reload or an accidentally closed tab ───────
const LS_LESSON_KEY = 'inclusivetalk_teacher_lesson'
const SAVED_LESSON_TTL_MS = 2 * 60 * 60 * 1000
const SAVED_LESSON_HEARTBEAT_MS = 10_000
// Server keeps a room for 60 s after the teacher disconnects; within that window students reconnect by themselves
const ROOM_GRACE_MS = 60_000

interface SavedLesson {
  code: string
  lang: Lang
  token: string
  savedAt: number
}

function readSavedLesson(): SavedLesson | null {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_LESSON_KEY) ?? 'null') as Partial<SavedLesson> | null
    if (!raw || !/^\d{6}$/.test(String(raw.code)) || !LANGS.includes(raw.lang as Lang)
      || typeof raw.token !== 'string' || typeof raw.savedAt !== 'number'
      || Date.now() - raw.savedAt > SAVED_LESSON_TTL_MS) return null
    return raw as SavedLesson
  } catch { return null }
}

function saveLesson(lesson: SavedLesson): void {
  try { localStorage.setItem(LS_LESSON_KEY, JSON.stringify(lesson)) } catch { /* storage unavailable */ }
}

function clearSavedLesson(): void {
  try { localStorage.removeItem(LS_LESSON_KEY) } catch { /* storage unavailable */ }
}

/** Properly closes a lesson left over from a previous page, so its students see "lesson ended". */
function endLeftoverLesson(lesson: SavedLesson): void {
  try {
    const ws = new WebSocket(getWsUrl())
    ws.onopen = () => ws.send(JSON.stringify({ type: 'register', role: 'teacher', code: lesson.code, language: lesson.lang, token: lesson.token }))
    ws.onmessage = e => {
      const msg = JSON.parse(String(e.data)) as { type?: string }
      if (msg.type === 'registered') ws.send(JSON.stringify({ type: 'end_lesson' }))
      else ws.close()
    }
    setTimeout(() => ws.close(), 5_000)
  } catch { /* best effort */ }
}

export default function TeacherPage() {
  const [state, setState] = useState<LessonState>('idle')
  const [language, setLanguage] = useState<Lang>('ru')
  const [code, setCode] = useState('')
  // Each phrase keeps its language, so screen readers read mixed RU/KZ lessons correctly
  const [transcript, setTranscript] = useState<Array<{ text: string; lang: Lang }>>([])
  // Words being recognized right now (not final yet) — shows the teacher that the mic hears them
  const [interim, setInterim] = useState('')
  const [connected, setConnected] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  const [signals, setSignals] = useState<FeedbackItem[]>([])
  const [toast, setToast] = useState<FeedbackItem | null>(null)
  const [signalPanelOpen, setSignalPanelOpen] = useState(false)

  // Teacher-only: notification sound can be turned off (saved on this device)
  const [soundOn, setSoundOn] = useState(() => {
    if (typeof window === 'undefined') return true
    try { return localStorage.getItem(LS_SOUND_KEY) !== 'off' } catch { return true }
  })

  const [micOn, setMicOn] = useState(true)
  const [micError, setMicError] = useState('')
  const [confirmEndOpen, setConfirmEndOpen] = useState(false)
  // Read on the client only; rendered after hydration (see `mounted`)
  const mounted = useMounted()
  const [savedLesson, setSavedLesson] = useState<(SavedLesson & { roomAlive: boolean }) | null>(() => {
    if (typeof window === 'undefined') return null
    const lesson = readSavedLesson()
    return lesson && { ...lesson, roomAlive: Date.now() - lesson.savedAt < ROOM_GRACE_MS - SAVED_LESSON_HEARTBEAT_MS }
  })

  const [students, setStudents] = useState<StudentInfo[]>([])
  const [studentPanelOpen, setStudentPanelOpen] = useState(false)
  const [joinToast, setJoinToast] = useState<{ name: string } | null>(null)

  const [, setTick] = useState(0)

  const wsRef = useRef<WebSocket | null>(null)
  const recognitionRef = useRef<SpeechRecognition | null>(null)
  const isLiveRef = useRef(false)
  const micOnRef = useRef(true)
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const joinToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptsRef = useRef(0)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const languageRef = useRef<Lang>('ru')
  const soundOnRef = useRef(soundOn)
  const signalsRef = useRef<FeedbackItem[]>([])
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

  useEffect(() => { soundOnRef.current = soundOn }, [soundOn])
  useEffect(() => { signalsRef.current = signals }, [signals])

  // Esc closes the mobile panels
  useEffect(() => {
    if (!studentPanelOpen && !signalPanelOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setStudentPanelOpen(false); setSignalPanelOpen(false) }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [studentPanelOpen, signalPanelOpen])

  // Keep the laptop screen on while the teacher is talking
  useWakeLock(state === 'active' || state === 'connecting')

  const showToast = useCallback((item: FeedbackItem | null, ms = TOAST_MS) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast(item)
    if (item) toastTimerRef.current = setTimeout(() => setToast(null), ms)
  }, [])

  const connectWs = useCallback((roomCode: string, lang: Lang, token: string | null) => {
    closeWs()
    const ws = new WebSocket(getWsUrl())
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
          // Remember the lesson so a reload or a closed tab can resume it with the same code
          const teacherToken = String(msg.teacherToken ?? '')
          if (teacherToken) saveLesson({ code: roomCode, lang, token: teacherToken, savedAt: Date.now() })

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

          // Keep students informed about the mic state (also after a reconnect)
          ws.send(JSON.stringify({ type: 'mic', on: micOnRef.current }))

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
              let draft = ''
              for (let i = evt.resultIndex; i < evt.results.length; i++) {
                const text = evt.results[i][0].transcript.trim()
                if (!text) continue
                if (evt.results[i].isFinal) {
                  setTranscript(prev => [...prev, { text, lang: languageRef.current }])
                  if (wsRef.current?.readyState === WebSocket.OPEN) {
                    wsRef.current.send(JSON.stringify({ type: 'transcript', text }))
                  }
                } else {
                  draft += text + ' '
                }
              }
              // Teacher-only preview; students get final phrases only (no flickering text)
              setInterim(draft.trim())
            }

            recognition.onerror = (evt: SpeechRecognitionErrorEvent) => {
              const micProblem = MIC_ERRORS[evt.error]
              if (micProblem) {
                // Don't pretend the mic works: switch it off and tell the teacher why
                micOnRef.current = false
                setMicOn(false)
                setMicError(micProblem)
                if (wsRef.current?.readyState === WebSocket.OPEN) {
                  wsRef.current.send(JSON.stringify({ type: 'mic', on: false }))
                }
              } else if (evt.error !== 'no-speech' && evt.error !== 'aborted') {
                console.warn(`[Speech] Error: ${evt.error}`)
              }
            }

            recognition.onend = () => {
              if (isLiveRef.current && micOnRef.current) {
                try { recognition.start() } catch { /* already restarting */ }
              }
            }

            if (micOnRef.current) recognition.start()
          }

        } else if (msg.type === 'error') {
          if (msg.code === 'room_taken') clearSavedLesson()
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
          joinToastTimerRef.current = setTimeout(() => setJoinToast(null), 4000)

        } else if (msg.type === 'student_left') {
          const studentId = String(msg.studentId ?? '')
          setStudents(prev => prev.filter(s => s.studentId !== studentId))

        } else if (msg.type === 'signal' || msg.type === 'question' || msg.type === 'gesture') {
          const base = {
            // Student-generated id: lets the student undo it and see the teacher's "Seen"
            id: String(msg.signalId || msg.feedbackId || '') || makeId(),
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
          showToast(item)
          if (soundOnRef.current) playBeep()

        } else if (msg.type === 'signal_cancelled') {
          // Student pressed "Undo": remove the signal quietly
          const signalId = String(msg.signalId ?? '')
          const studentId = String(msg.studentId ?? '')
          const match = (s: FeedbackItem) => s.id === signalId && s.studentId === studentId
          if (!signalId || !signalsRef.current.some(match)) return
          setSignals(prev => prev.filter(s => !match(s)))
          setToast(prev => (prev && match(prev) ? null : prev))
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
        setErrorMsg('Связь с сервером потеряна. Проверьте интернет и начните урок снова.')
        return
      }

      setReconnecting(true)
      const saved = readSavedLesson()
      const savedToken = saved?.code === roomCode ? saved.token : null
      reconnectTimerRef.current = setTimeout(() => {
        if (isLiveRef.current) connectWsRef.current?.(roomCode, languageRef.current, savedToken)
      }, reconnectDelay(reconnectAttemptsRef.current))
    }

    ws.onerror = () => { /* onclose handles it */ }
  }, [closeWs, stopAll, showToast])

  // Keep ref in sync so onclose can call connectWs without circular dep
  useEffect(() => {
    connectWsRef.current = connectWs
  }, [connectWs])

  const beginLesson = useCallback((roomCode: string, lang: Lang, token: string | null) => {
    const SpeechAPI = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!SpeechAPI) {
      setState('error')
      setErrorMsg('Этот браузер не умеет распознавать речь. Откройте сайт в Chrome или Edge.')
      return
    }

    languageRef.current = lang
    setLanguage(lang)
    setSavedLesson(null)
    setCode(roomCode)
    setTranscript([])
    setInterim('')
    setConnected(false)
    setReconnecting(false)
    setSignals([])
    setToast(null)
    setSignalPanelOpen(false)
    setStudents([])
    setStudentPanelOpen(false)
    setJoinToast(null)
    reconnectAttemptsRef.current = 0
    micOnRef.current = true
    setMicOn(true)
    setMicError('')
    setState('connecting')

    connectWs(roomCode, lang, token)
  }, [connectWs])

  const startLesson = useCallback(() => {
    if (savedLesson) endLeftoverLesson(savedLesson)
    clearSavedLesson()
    beginLesson(generateCode(), language, null)
  }, [beginLesson, language, savedLesson])

  const resumeLesson = useCallback(() => {
    if (savedLesson) beginLesson(savedLesson.code, savedLesson.lang, savedLesson.token)
  }, [beginLesson, savedLesson])

  const discardSavedLesson = useCallback(() => {
    if (savedLesson) endLeftoverLesson(savedLesson)
    clearSavedLesson()
    setSavedLesson(null)
  }, [savedLesson])

  // Heartbeat: tells a reloaded page how long ago the lesson was last alive
  useEffect(() => {
    if (state !== 'active') return
    const id = setInterval(() => {
      const lesson = readSavedLesson()
      if (lesson) saveLesson({ ...lesson, savedAt: Date.now() })
    }, SAVED_LESSON_HEARTBEAT_MS)
    return () => clearInterval(id)
  }, [state])

  // Ask before closing the tab mid-lesson (the browser shows its own dialog)
  useEffect(() => {
    if (state !== 'active' && state !== 'connecting') return
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [state])

  const stopLesson = useCallback(() => {
    // Tell the server explicitly, so students see "lesson ended" right away
    // instead of "teacher lost connection" for the 60 s grace period
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'end_lesson' }))
    }
    clearSavedLesson()
    stopAll()
    setInterim('')
    setConfirmEndOpen(false)
    setConnected(false)
    setReconnecting(false)
    setState('stopped')
  }, [stopAll])

  const retry = useCallback(() => {
    stopAll()
    setState('idle')
    setCode('')
    setTranscript([])
    setErrorMsg('')
    setSignals([])
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
  }, [])

  // Switch the lesson language without ending the lesson (mixed RU/KZ lessons are common)
  const changeLessonLanguage = useCallback((lang: Lang) => {
    if (lang === languageRef.current) return
    languageRef.current = lang
    setLanguage(lang)
    setInterim('')
    const recognition = recognitionRef.current
    if (recognition) {
      recognition.lang = SPEECH_LOCALE[lang]
      // stop() finalizes the current phrase; onend restarts recognition in the new language
      if (micOnRef.current) { try { recognition.stop() } catch { /* already stopped */ } }
    }
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'language', language: lang }))
    }
    const saved = readSavedLesson()
    if (saved) saveLesson({ ...saved, lang })
  }, [])

  const acknowledge = useCallback((item: FeedbackItem) => {
    setSignals(prev => prev.map(s => (s.id === item.id ? { ...s, acknowledged: true } : s)))
    setToast(prev => (prev?.id === item.id ? null : prev))
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'ack', feedbackId: item.id, studentId: item.studentId }))
    }
  }, [])

  const toggleMic = useCallback(() => {
    const next = !micOnRef.current
    micOnRef.current = next
    setMicOn(next)
    setInterim('')
    setMicError('')
    const recognition = recognitionRef.current
    if (recognition) {
      if (next) {
        // If the previous stop() is still finishing, onend will restart it instead
        try { recognition.start() } catch { /* still stopping */ }
      } else {
        try { recognition.stop() } catch { /* already stopped */ }
      }
    }
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'mic', on: next }))
    }
  }, [])

  const toggleSound = useCallback(() => {
    setSoundOn(prev => {
      const next = !prev
      try { localStorage.setItem(LS_SOUND_KEY, next ? 'on' : 'off') } catch { /* storage unavailable */ }
      return next
    })
  }, [])


  // ── Idle / Stopped ─────────────────────────────────────────────────────────
  if (state === 'idle' || state === 'stopped') {
    return (
      <div className="min-h-screen flex flex-col bg-white dark:bg-gray-950">
        <SiteHeader />
        <main id="main" className="flex-1 flex items-center justify-center px-4">
          <div className="text-center space-y-6">
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Преподаватель</h1>
            {mounted && savedLesson && state === 'idle' && (
              <section
                aria-labelledby="resume-title"
                className="text-left max-w-md mx-auto rounded-2xl border-2 border-blue-200 bg-blue-50 dark:border-blue-900 dark:bg-blue-950/40 p-5 space-y-3"
              >
                <h2 id="resume-title" className="text-lg font-semibold text-gray-900 dark:text-white">
                  Урок {savedLesson.code} не был завершён
                </h2>
                <p className="text-base text-gray-700 dark:text-gray-200">
                  {savedLesson.roomAlive
                    ? 'Продолжите его с тем же кодом — студенты подключатся снова сами.'
                    : `Продолжите его с тем же кодом — студентам нужно будет снова ввести код ${savedLesson.code}.`}
                </p>
                <div className="flex flex-col sm:flex-row gap-2">
                  <button
                    onClick={resumeLesson}
                    className="flex-1 py-3 rounded-xl bg-blue-700 hover:bg-blue-800 text-white font-semibold transition-colors"
                  >
                    Продолжить урок {savedLesson.code}
                  </button>
                  <button
                    onClick={discardSavedLesson}
                    className="flex-1 py-3 rounded-xl border-2 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-white font-semibold hover:bg-white dark:hover:bg-gray-800 transition-colors"
                  >
                    Завершить его
                  </button>
                </div>
              </section>
            )}
            {state === 'stopped' && (
              <p role="status" className="text-base text-gray-700 dark:text-gray-200">Урок завершён. Можно начать новый.</p>
            )}
            <div role="group" aria-labelledby="lesson-lang-label" className="space-y-2">
              <p id="lesson-lang-label" className="text-base font-medium text-gray-700 dark:text-gray-200">Язык урока</p>
              <div className="flex flex-col sm:flex-row gap-2 justify-center">
                {LANGS.map(lang => (
                  <button
                    key={lang}
                    lang={lang}
                    aria-pressed={language === lang}
                    onClick={() => setLanguage(lang)}
                    className={`px-5 py-2.5 rounded-xl text-base font-medium border-2 transition-colors ${
                      language === lang
                        ? 'bg-blue-700 border-blue-700 text-white'
                        : 'bg-white border-gray-300 text-gray-800 hover:border-blue-600 dark:bg-gray-900 dark:border-gray-600 dark:text-gray-100'
                    }`}
                  >
                    {LANG_NAMES[lang]}
                  </button>
                ))}
              </div>
            </div>
            {mounted && savedLesson && state === 'idle' ? (
              <button
                onClick={startLesson}
                className="block mx-auto px-8 py-3 border-2 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-white text-base font-semibold rounded-2xl hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              >
                Начать новый урок
              </button>
            ) : (
              <button
                onClick={startLesson}
                className="block mx-auto px-10 py-4 bg-blue-700 hover:bg-blue-800 text-white text-lg font-semibold rounded-2xl transition-colors"
              >
                Начать урок
              </button>
            )}
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
        <main id="main" className="flex-1 flex items-center justify-center px-4">
          <div className="text-center space-y-4 max-w-sm">
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Не получилось начать урок</h1>
            <p role="alert" className="text-lg text-gray-700 dark:text-gray-200">{errorMsg}</p>
            <button
              onClick={retry}
              className="px-6 py-3 bg-blue-700 hover:bg-blue-800 text-white font-semibold rounded-xl transition-colors"
            >
              Попробовать снова
            </button>
          </div>
        </main>
      </div>
    )
  }

  // ── Active — shared sub-components ────────────────────────────────────────

  const studentListContent = students.length === 0 ? (
    <p className="text-center text-gray-600 dark:text-gray-300 text-sm py-6 px-4">
      Пока никого. Покажите студентам код урока.
    </p>
  ) : (
    <ul>
      {students.map(student => (
        <li key={student.studentId} className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-800 last:border-0">
          <span aria-hidden="true" className={`w-8 h-8 flex items-center justify-center rounded-full text-white text-sm font-bold shrink-0 ${getAvatarColor(student.name)}`}>
            {student.name.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{student.name}</p>
            <p className="text-xs text-gray-600 dark:text-gray-300">вход: {formatTime(student.joinedAt)}</p>
          </div>
        </li>
      ))}
    </ul>
  )

  const signalListContent = signals.length === 0 ? (
    <p className="text-center text-gray-600 dark:text-gray-300 text-sm py-8 px-4">Сигналов пока нет</p>
  ) : (
    <ul>
      {signals.map(item => (
        <li key={item.id} className="flex items-start gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-800 last:border-0">
          <FeedbackIcon item={item} />
          <div className="min-w-0 flex-1">
            {item.kind === 'question' ? (
              <>
                <p className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">{item.studentName} спрашивает:</p>
                <p className="text-sm text-gray-900 dark:text-gray-100 leading-relaxed break-words whitespace-pre-wrap">«{item.questionText}»</p>
              </>
            ) : (
              <p className="text-sm font-medium text-gray-900 dark:text-gray-100 break-words">{feedbackText(item)}</p>
            )}
            <div className="flex items-center justify-between gap-2 mt-1">
              <p className="text-xs text-gray-600 dark:text-gray-300">{formatTime(item.timestamp)}</p>
              {item.acknowledged ? (
                <span className="text-xs font-medium text-green-800 dark:text-green-300">
                  <span aria-hidden="true">✓ </span>Принято
                </span>
              ) : (
                <button
                  onClick={() => acknowledge(item)}
                  aria-label={`Принято: ${feedbackText(item)}`}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold border-2 border-gray-300 text-gray-800 hover:border-green-700 hover:text-green-800 dark:border-gray-600 dark:text-gray-100 dark:hover:border-green-400 transition-colors"
                >
                  Принято
                </button>
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  )

  // ── Active ─────────────────────────────────────────────────────────────────
  // "New" = not yet acknowledged by the teacher
  const unreadCount = signals.filter(s => !s.acknowledged).length
  const statusText = connected
    ? 'Подключено'
    : state === 'connecting'
    ? 'Подключение…'
    : reconnecting
    ? 'Восстанавливаем связь…'
    : 'Нет связи'

  const sheetClass = 'md:hidden fixed bottom-20 left-0 right-0 z-30 bg-white dark:bg-gray-900 rounded-t-2xl border-t border-gray-300 dark:border-gray-700 shadow-2xl max-h-72 flex flex-col'
  const closeBtnClass = 'w-10 h-10 flex items-center justify-center rounded-lg text-gray-700 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800 text-lg leading-none'

  return (
    <div className="min-h-screen flex flex-col">
      <SiteHeader>
        <button
          onClick={toggleSound}
          aria-pressed={soundOn}
          title={soundOn ? 'Звук уведомлений включён' : 'Звук уведомлений выключен'}
          className="h-9 px-3 flex items-center gap-1.5 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800 transition-colors"
        >
          <span aria-hidden="true">{soundOn ? '🔔' : '🔕'}</span>
          <span className="hidden sm:inline">Звук</span>
          <span className="sr-only sm:hidden">Звук уведомлений</span>
        </button>
        <button
          onClick={() => setConfirmEndOpen(true)}
          aria-haspopup="dialog"
          className="px-4 py-2 bg-red-700 hover:bg-red-800 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          Завершить урок
        </button>
      </SiteHeader>

      {confirmEndOpen && (
        <Dialog title="Завершить урок для всех?" closeLabel="Закрыть" onClose={() => setConfirmEndOpen(false)}>
          <p className="text-base text-gray-700 dark:text-gray-200 mb-5">
            Студенты увидят «Урок завершён», субтитры перестанут приходить. Код {code} больше не будет работать.
          </p>
          <div className="flex flex-col-reverse sm:flex-row gap-2">
            <button
              data-autofocus
              onClick={() => setConfirmEndOpen(false)}
              className="flex-1 py-3 rounded-xl border-2 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-white font-semibold hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              Продолжить урок
            </button>
            <button
              onClick={stopLesson}
              className="flex-1 py-3 rounded-xl bg-red-700 hover:bg-red-800 text-white font-semibold transition-colors"
            >
              Завершить урок
            </button>
          </div>
        </Dialog>
      )}
      <div className="flex flex-1 min-h-0">
        <main id="main" className="flex-1 min-w-0 flex flex-col px-4 py-6 pb-24 md:pb-6 bg-white dark:bg-gray-950">
          <h1 className="sr-only">Урок {code}</h1>

          <section aria-label="Код урока" className="bg-gray-50 dark:bg-gray-900 rounded-2xl p-6 mb-6 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wider">Код урока</span>
              <div role="status" className="flex items-center gap-2">
                <span aria-hidden="true" className={`w-2.5 h-2.5 rounded-full ${connected ? 'bg-green-600' : 'bg-amber-500'}`} />
                <span className="text-sm text-gray-700 dark:text-gray-200">{statusText}</span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <span className="text-5xl font-mono font-bold text-gray-900 dark:text-white tracking-widest">{code}</span>
              <button
                onClick={copyCode}
                className="px-3 py-2 text-sm font-medium bg-blue-100 hover:bg-blue-200 dark:bg-blue-900/50 dark:hover:bg-blue-900/80 text-blue-800 dark:text-blue-200 rounded-lg transition-colors"
              >
                {copied ? 'Скопировано' : 'Копировать'}
              </button>
              <span role="status" className="sr-only">{copied ? 'Код скопирован' : ''}</span>
            </div>

            {state === 'active' && (
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <button
                  onClick={toggleMic}
                  aria-describedby="mic-status"
                  className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-base font-semibold border-2 transition-colors ${
                    micOn
                      ? 'bg-white border-gray-300 text-gray-900 hover:border-gray-500 dark:bg-gray-800 dark:border-gray-600 dark:text-white'
                      : 'bg-blue-700 border-blue-700 text-white hover:bg-blue-800'
                  }`}
                >
                  <span aria-hidden="true">{micOn ? '⏸' : '🎤'}</span>
                  {micOn ? 'Выключить микрофон' : 'Включить микрофон'}
                </button>
                <p id="mic-status" role="status" className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200">
                  <span aria-hidden="true" className={`w-2.5 h-2.5 rounded-full ${micOn ? 'bg-red-600' : 'bg-gray-400'}`} />
                  {micOn ? 'Микрофон включён' : 'Микрофон выключен — студенты видят паузу'}
                </p>
              </div>
            )}
            {state === 'active' && (
              <div role="group" aria-labelledby="live-lang-label" className="flex flex-wrap items-center gap-2">
                <span id="live-lang-label" className="text-sm text-gray-700 dark:text-gray-200">Язык урока:</span>
                {LANGS.map(lang => (
                  <button
                    key={lang}
                    lang={lang}
                    aria-pressed={language === lang}
                    onClick={() => changeLessonLanguage(lang)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium border-2 transition-colors ${
                      language === lang
                        ? 'bg-blue-700 border-blue-700 text-white'
                        : 'bg-white border-gray-300 text-gray-800 hover:border-blue-600 dark:bg-gray-800 dark:border-gray-600 dark:text-gray-100'
                    }`}
                  >
                    {LANG_NAMES[lang]}
                  </button>
                ))}
              </div>
            )}
            {micError && (
              <p role="alert" className="text-sm font-medium text-red-800 bg-red-50 border border-red-200 rounded-lg px-3 py-2 dark:text-red-200 dark:bg-red-950/40 dark:border-red-900">
                {micError}
              </p>
            )}
          </section>

          <section aria-labelledby="transcript-title" className="flex-1 bg-gray-50 dark:bg-gray-900 rounded-2xl p-6 min-h-64">
            <h2 id="transcript-title" className="text-xs font-semibold text-gray-600 dark:text-gray-300 uppercase tracking-wider mb-4">Текст урока</h2>
            {transcript.length > 0 || interim ? (
              <p className="text-gray-900 dark:text-gray-100 text-lg leading-relaxed whitespace-pre-wrap">
                {transcript.map((phrase, i) => <span key={i} lang={phrase.lang}>{phrase.text} </span>)}
                {interim && (
                  <span lang={language} className="text-gray-600 dark:text-gray-300 italic" title="Распознаётся — студенты увидят фразу целиком">
                    {interim}
                    <span className="sr-only"> (распознаётся)</span>
                  </span>
                )}
              </p>
            ) : (
              <p className="text-gray-600 dark:text-gray-300">
                {micOn ? 'Говорите — текст появится здесь и у студентов.' : 'Микрофон выключен. Включите его, чтобы продолжить субтитры.'}
              </p>
            )}
          </section>

          {/* Notifications live inside <main> so they belong to a landmark */}
          <div role="status" aria-live="polite">
            {toast && (
              <div
                onMouseEnter={() => toastTimerRef.current && clearTimeout(toastTimerRef.current)}
                onMouseLeave={() => showToast(toast, 4_000)}
                className="fixed top-20 right-4 md:right-[21rem] z-50 flex items-start gap-3 pl-4 pr-2 py-3 rounded-xl shadow-xl max-w-sm bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
              >
                <FeedbackIcon item={toast} />
                <p className="flex-1 min-w-0 pt-1 font-medium text-sm leading-snug break-words line-clamp-3">{feedbackText(toast)}</p>
                <button
                  onClick={() => acknowledge(toast)}
                  aria-label={`Принято: ${feedbackText(toast)}`}
                  className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold border-2 border-white/60 hover:bg-white/15 dark:border-gray-900/40 dark:hover:bg-black/10"
                >
                  Принято
                </button>
                <button
                  onClick={() => showToast(null)}
                  aria-label="Закрыть уведомление"
                  className="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg hover:bg-white/15 dark:hover:bg-black/10"
                >
                  <span aria-hidden="true">✕</span>
                </button>
              </div>
            )}
            {joinToast && (
              <p className="fixed bottom-24 left-4 z-50 px-4 py-3 rounded-xl shadow-xl bg-gray-800 text-white max-w-xs text-sm font-medium md:bottom-4">
                <span aria-hidden="true">👋 </span>{joinToast.name} — в уроке
              </p>
            )}
          </div>
        </main>

        {/* Desktop right sidebar */}
        <aside aria-label="Класс и сигналы" className="hidden md:flex w-80 shrink-0 flex-col bg-gray-50 dark:bg-gray-900 border-l border-gray-200 dark:border-gray-700">
          <section aria-labelledby="students-title" className="flex flex-col" style={{ maxHeight: '40%' }}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
              <h2 id="students-title" className="text-sm font-semibold text-gray-800 dark:text-gray-100">Студенты в классе</h2>
              <span className="bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-100 text-xs font-bold rounded-full px-2 py-0.5 min-w-[22px] text-center">
                {students.length}
              </span>
            </div>
            <div className="overflow-y-auto flex-1">{studentListContent}</div>
          </section>

          <section aria-labelledby="signals-title" className="flex flex-col flex-1 min-h-0 border-t border-gray-200 dark:border-gray-700">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700 shrink-0">
              <h2 id="signals-title" className="text-sm font-semibold text-gray-800 dark:text-gray-100">Сигналы от студентов</h2>
              {unreadCount > 0 && (
                <span className="bg-blue-700 text-white text-xs font-bold rounded-full px-2 py-0.5 min-w-[22px] text-center">
                  {unreadCount}<span className="sr-only"> новых</span>
                </span>
              )}
            </div>
            <div className="flex-1 overflow-y-auto">{signalListContent}</div>
            <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 shrink-0">
              <button
                onClick={clearSignals}
                className="w-full py-2 rounded-lg text-sm font-medium text-gray-700 hover:text-gray-900 hover:bg-gray-200 dark:text-gray-200 dark:hover:bg-gray-800 transition-colors"
              >
                Очистить список
              </button>
            </div>
          </section>
        </aside>
      </div>

      {/* Mobile: bottom buttons + sheets */}
      <nav aria-label="Панели урока" className="md:hidden fixed bottom-4 left-4 right-4 z-40 flex justify-between pointer-events-none">
        <button
          onClick={() => { setStudentPanelOpen(v => !v); setSignalPanelOpen(false) }}
          aria-expanded={studentPanelOpen}
          aria-controls="students-sheet"
          className="pointer-events-auto flex items-center gap-2 px-4 py-3 bg-gray-800 hover:bg-gray-700 text-white font-medium rounded-full shadow-lg transition-colors"
        >
          <span aria-hidden="true">👥</span>
          <span className="text-sm">Студенты ({students.length})</span>
        </button>
        <button
          onClick={() => { setSignalPanelOpen(v => !v); setStudentPanelOpen(false) }}
          aria-expanded={signalPanelOpen}
          aria-controls="signals-sheet"
          className="pointer-events-auto flex items-center gap-2 px-4 py-3 bg-blue-700 hover:bg-blue-800 text-white font-medium rounded-full shadow-lg transition-colors"
        >
          <span aria-hidden="true">📥</span>
          <span className="text-sm">Сигналы{unreadCount > 0 ? ` (${unreadCount})` : ''}</span>
        </button>
      </nav>

      {studentPanelOpen && (
        <section id="students-sheet" aria-labelledby="students-sheet-title" className={sheetClass}>
          <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-800 shrink-0">
            <h2 id="students-sheet-title" className="text-sm font-semibold text-gray-800 dark:text-gray-100">
              Студенты в классе ({students.length})
            </h2>
            <button onClick={() => setStudentPanelOpen(false)} aria-label="Закрыть список студентов" className={closeBtnClass}>
              <span aria-hidden="true">✕</span>
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">{studentListContent}</div>
        </section>
      )}

      {signalPanelOpen && (
        <section id="signals-sheet" aria-labelledby="signals-sheet-title" className={sheetClass}>
          <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-800 shrink-0">
            <h2 id="signals-sheet-title" className="text-sm font-semibold text-gray-800 dark:text-gray-100">
              Сигналы от студентов{unreadCount > 0 ? ` (${unreadCount})` : ''}
            </h2>
            <button onClick={() => setSignalPanelOpen(false)} aria-label="Закрыть сигналы" className={closeBtnClass}>
              <span aria-hidden="true">✕</span>
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">{signalListContent}</div>
          <div className="px-4 py-2 border-t border-gray-200 dark:border-gray-800 shrink-0">
            <button
              onClick={() => { clearSignals(); setSignalPanelOpen(false) }}
              className="w-full py-2 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-800 transition-colors"
            >
              Очистить список
            </button>
          </div>
        </section>
      )}
    </div>
  )
}
