import Fastify from 'fastify'
import cors from '@fastify/cors'
import websocketPlugin from '@fastify/websocket'
import { WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'

// ── Constants ─────────────────────────────────────────────────────────────────

const GRACE_PERIOD_MS = 60_000       // 60 s before room is closed after teacher disconnect
const HEARTBEAT_INTERVAL_MS = 30_000 // ping all sockets every 30 s
const MAX_TRANSCRIPT_LEN = 3_000
const VALID_SIGNALS = ['confused', 'repeat', 'slow', 'question', 'understood']
const VALID_LANGUAGES = ['ru', 'kk', 'en'] as const
type RoomLanguage = typeof VALID_LANGUAGES[number]

// ── Room state ────────────────────────────────────────────────────────────────

interface Student {
  id: string
  name: string
  socket: WebSocket
  joinedAt: number
}

interface Room {
  teacher: WebSocket | null
  teacherToken: string
  gracePeriodTimer: ReturnType<typeof setTimeout> | null
  students: Map<string, Student>
  language: RoomLanguage
  micOn: boolean
}

interface SocketMeta {
  code: string
  role: 'teacher' | 'student'
  name?: string
  studentId?: string
}

const rooms = new Map<string, Room>()
const socketMeta = new Map<WebSocket, SocketMeta>()
const isAlive = new WeakMap<WebSocket, boolean>()

// ── Helpers ───────────────────────────────────────────────────────────────────

function send(socket: WebSocket, msg: object): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg))
  }
}

function broadcastStudents(room: Room, msg: object): void {
  for (const student of room.students.values()) send(student.socket, msg)
}

function closeRoom(code: string, reason: 'ended_by_teacher' | 'teacher_timeout'): void {
  const room = rooms.get(code)
  if (!room) return
  if (room.gracePeriodTimer) clearTimeout(room.gracePeriodTimer)
  broadcastStudents(room, { type: 'room_closed', reason })
  rooms.delete(code)
  app.log.info({ code, reason }, 'Room closed')
}

/** Client-generated id of a signal/question/gesture (for "Undo" and "Seen"); short printable string or ''. */
function toFeedbackId(raw: unknown): string {
  const id = String(raw ?? '')
  return /^[\w-]{1,64}$/.test(id) ? id : ''
}

function toLang(raw: string): RoomLanguage {
  return (VALID_LANGUAGES as readonly string[]).includes(raw)
    ? (raw as RoomLanguage)
    : 'ru'
}

// ── Server ────────────────────────────────────────────────────────────────────

const app = Fastify({ logger: { level: 'info' } })

await app.register(cors, { origin: true })
await app.register(websocketPlugin)

app.get('/', async () => ({ status: 'ok', rooms: rooms.size }))

app.get('/ws', { websocket: true }, (socket: WebSocket) => {
  isAlive.set(socket, true)
  socket.on('pong', () => isAlive.set(socket, true))

  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>

      // ── register ────────────────────────────────────────────────────────
      if (msg.type === 'register') {
        const role = String(msg.role ?? '')
        const code = String(msg.code ?? '')
        if (!role || !code) return

        if (role === 'teacher') {
          const language = toLang(String(msg.language ?? 'ru'))
          const existingRoom = rooms.get(code)

          if (!existingRoom) {
            // New room — generate token
            const teacherToken = randomUUID()
            rooms.set(code, {
              teacher: null,
              teacherToken,
              gracePeriodTimer: null,
              micOn: true,
              students: new Map<string, Student>(),
              language,
            })
            app.log.info({ code }, 'Room created')
          } else {
            // Existing room — validate token
            const providedToken = String(msg.token ?? '')
            if (providedToken !== existingRoom.teacherToken) {
              send(socket, { type: 'error', code: 'room_taken', message: 'Комната уже занята' })
              socket.close()
              return
            }
            // Cancel grace period if active
            if (existingRoom.gracePeriodTimer) {
              clearTimeout(existingRoom.gracePeriodTimer)
              existingRoom.gracePeriodTimer = null
            }
            existingRoom.language = language
          }

          const room = rooms.get(code)!
          const isReconnect = room.teacher === null && existingRoom !== undefined
          room.teacher = socket
          socketMeta.set(socket, { code, role: 'teacher' })

          const studentsList = Array.from(room.students.values()).map(s => ({
            studentId: s.id,
            name: s.name,
            joinedAt: s.joinedAt,
          }))
          send(socket, { type: 'registered', students: studentsList, teacherToken: room.teacherToken })

          if (isReconnect) {
            broadcastStudents(room, { type: 'teacher_reconnected' })
            app.log.info({ code }, 'Teacher reconnected, grace period cancelled')
          } else {
            app.log.info({ code }, 'Teacher registered room')
          }

        } else if (role === 'student') {
          const room = rooms.get(code)
          if (!room) {
            send(socket, { type: 'error', code: 'room_not_found', message: 'Комната не найдена' })
            socket.close()
            return
          }
          const name = String(msg.name ?? '').trim()
          if (!name || name.length > 50) {
            send(socket, { type: 'error', code: 'name_required', message: 'Имя обязательно' })
            socket.close()
            return
          }
          const studentId = randomUUID()
          const joinedAt = Date.now()
          const student: Student = { id: studentId, name, socket, joinedAt }
          room.students.set(studentId, student)
          socketMeta.set(socket, { code, role: 'student', name, studentId })
          send(socket, { type: 'joined', studentId, language: room.language, micOn: room.micOn })

          if (room.teacher) {
            send(room.teacher, { type: 'student_joined', studentId, name, joinedAt })
          } else {
            // Teacher is temporarily disconnected
            send(socket, { type: 'teacher_disconnected' })
          }
          app.log.info({ code, studentId, name }, 'Student joined room')
        }

      // ── transcript (teacher → students) ─────────────────────────────────
      } else if (msg.type === 'end_lesson') {
        // ── end_lesson (teacher): close the room right away, no grace period
        const meta = socketMeta.get(socket)
        if (!meta || meta.role !== 'teacher') return
        const room = rooms.get(meta.code)
        if (!room || room.teacher !== socket) return
        socketMeta.delete(socket)  // so the following 'close' isn't treated as a disconnect
        closeRoom(meta.code, 'ended_by_teacher')
        socket.close()

      } else if (msg.type === 'ack') {
        // ── ack (teacher → one student): "I saw your signal / question"
        const meta = socketMeta.get(socket)
        if (!meta || meta.role !== 'teacher') return
        const room = rooms.get(meta.code)
        if (!room || room.teacher !== socket) return
        const feedbackId = toFeedbackId(msg.feedbackId)
        const student = room.students.get(String(msg.studentId ?? ''))
        if (!feedbackId || !student) return
        send(student.socket, { type: 'acknowledged', feedbackId })

      } else if (msg.type === 'language') {
        // ── language (teacher → students): lesson language switched mid-lesson
        const meta = socketMeta.get(socket)
        if (!meta || meta.role !== 'teacher') return
        const room = rooms.get(meta.code)
        if (!room || room.teacher !== socket) return
        const language = toLang(String(msg.language ?? ''))
        if (language === room.language) return
        room.language = language
        broadcastStudents(room, { type: 'lesson_language', language })
        app.log.info({ code: meta.code, language }, 'Lesson language changed')

      } else if (msg.type === 'mic') {
        // ── mic (teacher → students): teacher paused / resumed the microphone
        const meta = socketMeta.get(socket)
        if (!meta || meta.role !== 'teacher') return
        const room = rooms.get(meta.code)
        if (!room || room.teacher !== socket) return
        const on = msg.on === true
        if (room.micOn === on) return
        room.micOn = on
        broadcastStudents(room, { type: 'teacher_mic', on })
        app.log.info({ code: meta.code, on }, 'Teacher microphone toggled')

      } else if (msg.type === 'transcript') {
        const meta = socketMeta.get(socket)
        if (!meta || meta.role !== 'teacher') return
        const room = rooms.get(meta.code)
        if (!room || room.teacher !== socket) return
        const text = String(msg.text ?? '').trim()
        if (!text || text.length > MAX_TRANSCRIPT_LEN) return
        broadcastStudents(room, { type: 'transcript', text, lang: room.language })
        app.log.info({ code: meta.code, students: room.students.size }, 'Transcript broadcast')

      // ── signal (student → teacher) ────────────────────────────────────────
      } else if (msg.type === 'signal') {
        const meta = socketMeta.get(socket)
        if (!meta || meta.role !== 'student') return
        const room = rooms.get(meta.code)
        if (!room) return
        const signalType = String(msg.signalType ?? '')
        if (!VALID_SIGNALS.includes(signalType)) return
        const signalId = toFeedbackId(msg.signalId)
        if (room.teacher) {
          send(room.teacher, {
            type: 'signal',
            signalId,
            signalType,
            studentId: meta.studentId,
            name: meta.name,
            timestamp: Date.now(),
          })
        }
        app.log.info({ code: meta.code, signalType, student: meta.name }, 'Signal received')

      // ── signal_cancel (student → teacher): student pressed "Undo" ─────────
      } else if (msg.type === 'signal_cancel') {
        const meta = socketMeta.get(socket)
        if (!meta || meta.role !== 'student') return
        const room = rooms.get(meta.code)
        if (!room) return
        const signalId = toFeedbackId(msg.signalId)
        if (!signalId) return
        if (room.teacher) {
          send(room.teacher, { type: 'signal_cancelled', signalId, studentId: meta.studentId })
        }
        app.log.info({ code: meta.code, student: meta.name }, 'Signal cancelled')

      // ── question (student → teacher) ──────────────────────────────────────
      } else if (msg.type === 'question') {
        const meta = socketMeta.get(socket)
        if (!meta || meta.role !== 'student') return
        const room = rooms.get(meta.code)
        if (!room) return
        const text = String(msg.text ?? '').trim()
        if (!text || text.length > 500) return
        if (room.teacher) {
          send(room.teacher, {
            type: 'question',
            feedbackId: toFeedbackId(msg.feedbackId),
            text,
            studentId: meta.studentId,
            name: meta.name,
            timestamp: Date.now(),
          })
        }
        app.log.info({ code: meta.code, student: meta.name }, `Question: ${text.slice(0, 50)}`)

      // ── gesture (student → teacher) ───────────────────────────────────────
      } else if (msg.type === 'gesture') {
        const meta = socketMeta.get(socket)
        if (!meta || meta.role !== 'student') return
        const room = rooms.get(meta.code)
        if (!room) return
        const letter = String(msg.letter ?? '').trim()
        if (!letter) return
        if (room.teacher) {
          send(room.teacher, {
            type: 'gesture',
            feedbackId: toFeedbackId(msg.feedbackId),
            letter,
            studentId: meta.studentId,
            name: meta.name,
            timestamp: Date.now(),
          })
        }
        app.log.info({ code: meta.code, letter, student: meta.name }, 'Gesture received')
      }

    } catch {
      // ignore malformed JSON
    }
  })

  socket.on('close', () => {
    const meta = socketMeta.get(socket)
    if (!meta) return
    socketMeta.delete(socket)

    const room = rooms.get(meta.code)
    if (!room) return

    if (meta.role === 'teacher') {
      // Only start grace period if this socket is still the active teacher
      if (room.teacher !== socket) return
      room.teacher = null
      broadcastStudents(room, { type: 'teacher_disconnected' })
      room.gracePeriodTimer = setTimeout(() => {
        closeRoom(meta.code, 'teacher_timeout')
      }, GRACE_PERIOD_MS)
      app.log.info({ code: meta.code }, 'Teacher disconnected, grace period started')
    } else {
      if (meta.studentId) room.students.delete(meta.studentId)
      if (room.teacher) {
        send(room.teacher, { type: 'student_left', studentId: meta.studentId, name: meta.name })
      }
      app.log.info({ code: meta.code, name: meta.name, remaining: room.students.size }, 'Student left room')
    }
  })
})

// ── Start ─────────────────────────────────────────────────────────────────────

const port = Number(process.env.PORT) || 3001
await app.listen({ port, host: '0.0.0.0' })

// ── Heartbeat ─────────────────────────────────────────────────────────────────

const wss = app.websocketServer
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws: WebSocket) => {
    if (isAlive.get(ws) === false) {
      ws.terminate()
      return
    }
    isAlive.set(ws, false)
    ws.ping()
  })
}, HEARTBEAT_INTERVAL_MS)

wss.on('close', () => clearInterval(heartbeatInterval))
