'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import Dialog from './Dialog'
import type { UILabels } from '../i18n'

const MOCK_LETTERS = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З', 'И', 'К']

interface Props {
  t: UILabels
  onClose: () => void
  onSendGesture: (letter: string) => void
}

export default function GestureMockModal({ t, onClose, onSendGesture }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [cameraError, setCameraError] = useState(false)
  const [recognizing, setRecognizing] = useState(false)
  const [recognizedLetter, setRecognizedLetter] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    navigator.mediaDevices
      ?.getUserMedia({ video: true })
      .then(stream => {
        if (cancelled) {
          stream.getTracks().forEach(track => track.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) videoRef.current.srcObject = stream
      })
      .catch(() => { if (!cancelled) setCameraError(true) })

    return () => {
      cancelled = true
      if (timerRef.current) clearTimeout(timerRef.current)
      streamRef.current?.getTracks().forEach(track => track.stop())
      streamRef.current = null
    }
  }, [])

  const handleRecognize = useCallback(() => {
    if (recognizing) return
    setRecognizing(true)
    setRecognizedLetter(null)
    timerRef.current = setTimeout(() => {
      setRecognizedLetter(MOCK_LETTERS[Math.floor(Math.random() * MOCK_LETTERS.length)])
      setRecognizing(false)
    }, 2000 + Math.random() * 1000)
  }, [recognizing])

  const handleSend = useCallback(() => {
    if (!recognizedLetter) return
    onSendGesture(recognizedLetter)
    onClose()
  }, [recognizedLetter, onSendGesture, onClose])

  return (
    <Dialog title={t.gestureTitle} closeLabel={t.close} onClose={onClose}>
      <div className="space-y-4">
        <p className="it-surface it-text it-border text-sm leading-snug rounded-xl border border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:border-amber-700 dark:text-amber-100 px-4 py-3">
          {t.gestureDemoNote}
        </p>

        <div className="relative w-full rounded-xl overflow-hidden bg-gray-900" style={{ aspectRatio: '4/3' }}>
          {cameraError ? (
            <p className="absolute inset-0 flex items-center justify-center text-center p-4 text-gray-200 text-sm">
              {t.gestureAllowCamera}
            </p>
          ) : (
            <video ref={videoRef} autoPlay playsInline muted aria-hidden="true" className="w-full h-full object-cover" />
          )}
        </div>

        <div role="status" className="text-center min-h-0">
          {recognizedLetter && (
            <div className="py-2">
              <p className="it-muted text-gray-600 dark:text-gray-300 text-sm mb-1">{t.gestureRecognized}</p>
              <p className="it-text text-5xl font-bold text-violet-700 dark:text-violet-300">{recognizedLetter}</p>
            </div>
          )}
          {recognizing && <span className="sr-only">{t.gestureRecognizing}</span>}
        </div>

        {!recognizedLetter ? (
          <button
            onClick={handleRecognize}
            disabled={recognizing || cameraError}
            className="w-full py-3 bg-violet-700 hover:bg-violet-800 disabled:bg-gray-200 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white disabled:text-gray-600 dark:disabled:text-gray-300 font-medium rounded-xl transition-colors"
          >
            {recognizing ? t.gestureRecognizing : t.gestureRecognize}
          </button>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={() => setRecognizedLetter(null)}
              className="it-text it-border flex-1 py-3 border-2 border-gray-300 dark:border-gray-600 text-gray-800 dark:text-gray-100 hover:border-violet-500 font-medium rounded-xl transition-colors"
            >
              {t.gestureRetry}
            </button>
            <button
              onClick={handleSend}
              className="flex-1 py-3 bg-violet-700 hover:bg-violet-800 text-white font-medium rounded-xl transition-colors"
            >
              {t.gestureSend}
            </button>
          </div>
        )}
      </div>
    </Dialog>
  )
}
