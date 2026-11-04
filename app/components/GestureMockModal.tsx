'use client'

import { useEffect, useRef, useState, useCallback } from 'react'

const MOCK_LETTERS = ['А', 'Б', 'В', 'Г', 'Д', 'Е', 'Ж', 'З', 'И', 'К']

interface Props {
  onClose: () => void
  onSendGesture: (letter: string) => void
}

export default function GestureMockModal({ onClose, onSendGesture }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [cameraError, setCameraError] = useState(false)
  const [recognizing, setRecognizing] = useState(false)
  const [recognizedLetter, setRecognizedLetter] = useState<string | null>(null)

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop())
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    navigator.mediaDevices
      .getUserMedia({ video: true })
      .then(stream => {
        if (cancelled) {
          stream.getTracks().forEach(t => t.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
        }
      })
      .catch(() => {
        if (!cancelled) setCameraError(true)
      })

    return () => {
      cancelled = true
      stopCamera()
    }
  }, [stopCamera])

  const handleRecognize = useCallback(() => {
    if (recognizing) return
    setRecognizing(true)
    setRecognizedLetter(null)
    const delay = 2000 + Math.random() * 1000
    setTimeout(() => {
      const letter = MOCK_LETTERS[Math.floor(Math.random() * MOCK_LETTERS.length)]
      setRecognizedLetter(letter)
      setRecognizing(false)
    }, delay)
  }, [recognizing])

  const handleSend = useCallback(() => {
    if (!recognizedLetter) return
    onSendGesture(recognizedLetter)
    onClose()
  }, [recognizedLetter, onSendGesture, onClose])

  const handleRetry = useCallback(() => {
    setRecognizedLetter(null)
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-sm bg-white dark:bg-gray-900 rounded-2xl shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">🤚 Жестовый перевод</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-xl leading-none transition-colors"
            aria-label="Закрыть"
          >
            ✕
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Warning banner — always visible, non-dismissible */}
          <div className="flex items-start gap-2.5 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-xl px-4 py-3">
            <span className="text-amber-500 text-lg shrink-0 mt-0.5">⚠️</span>
            <p className="text-sm text-amber-800 dark:text-amber-200 leading-snug">
              <span className="font-semibold">Прототип интерфейса.</span> Распознавание жестов — Фаза&nbsp;3 нашего roadmap. Сейчас работает имитация на основе таймера.
            </p>
          </div>

          {/* Camera feed */}
          <div
            className="relative w-full rounded-xl overflow-hidden bg-gray-900"
            style={{ aspectRatio: '4/3' }}
          >
            {cameraError ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center p-4">
                <span className="text-4xl mb-3">📷</span>
                <p className="text-gray-400 text-sm">Разрешите доступ к камере</p>
              </div>
            ) : (
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover"
              />
            )}
          </div>

          {/* Recognition result */}
          {recognizedLetter && (
            <div className="text-center py-2">
              <p className="text-gray-500 dark:text-gray-400 text-sm mb-1">Распознано:</p>
              <p className="text-5xl font-bold text-violet-600 dark:text-violet-400">
                {recognizedLetter}
              </p>
            </div>
          )}

          {/* Action buttons */}
          {!recognizedLetter ? (
            <button
              onClick={handleRecognize}
              disabled={recognizing || cameraError}
              className="w-full py-3 bg-violet-600 hover:bg-violet-700 disabled:bg-gray-200 dark:disabled:bg-gray-700 disabled:cursor-not-allowed text-white disabled:text-gray-400 dark:disabled:text-gray-500 font-medium rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              {recognizing ? (
                <>
                  <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  <span>Распознаю...</span>
                </>
              ) : (
                'Распознать букву'
              )}
            </button>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={handleRetry}
                className="flex-1 py-3 border-2 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-violet-400 dark:hover:border-violet-500 font-medium rounded-xl transition-colors"
              >
                Ещё раз
              </button>
              <button
                onClick={handleSend}
                className="flex-1 py-3 bg-violet-600 hover:bg-violet-700 text-white font-medium rounded-xl transition-colors"
              >
                Отправить учителю
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
