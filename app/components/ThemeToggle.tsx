'use client'

import { useState } from 'react'
import { useMounted } from '../useMounted'

export default function ThemeToggle() {
  const mounted = useMounted()
  const [isDark, setIsDark] = useState(() => {
    if (typeof document === 'undefined') return false
    return document.documentElement.classList.contains('dark')
  })

  const toggle = () => {
    const next = !isDark
    setIsDark(next)
    document.documentElement.classList.toggle('dark', next)
    try { localStorage.setItem('theme', next ? 'dark' : 'light') } catch { /* storage unavailable */ }
  }

  return (
    <button
      onClick={toggle}
      aria-label={!mounted ? 'Переключить тему' : isDark ? 'Включить светлую тему' : 'Включить тёмную тему'}
      className="w-9 h-9 flex items-center justify-center rounded-lg text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-lg leading-none"
    >
      {mounted ? (isDark ? '☀️' : '🌙') : null}
    </button>
  )
}
