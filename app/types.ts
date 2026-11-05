export type SignalType = 'confused' | 'repeat' | 'slow' | 'question' | 'understood'

export interface FeedbackItem {
  id: string
  kind: 'signal' | 'question' | 'gesture'
  signalType?: SignalType
  questionText?: string
  gestureLetter?: string
  timestamp: number
  studentId: string
  studentName: string
  /** Teacher pressed "Seen"; the student was notified */
  acknowledged?: boolean
}

export interface StudentInfo {
  studentId: string
  name: string
  joinedAt: number
}
