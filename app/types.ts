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
}

export interface StudentInfo {
  studentId: string
  name: string
  joinedAt: number
}
