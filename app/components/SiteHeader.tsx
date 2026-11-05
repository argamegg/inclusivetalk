import Image from 'next/image'
import Link from 'next/link'
import ThemeToggle from './ThemeToggle'

export default function SiteHeader({ children }: { children?: React.ReactNode }) {
  return (
    <header className="it-surface it-border flex items-center justify-between gap-2 px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
      <Link href="/" className="flex items-center gap-2 rounded-lg">
        <Image src="/logo-mark.png" alt="" width={36} height={36} className="it-logo dark:brightness-0 dark:invert" />
        <span className="it-text text-lg font-bold text-gray-900 dark:text-white">InclusiveTalk</span>
      </Link>
      <div className="flex items-center gap-1">
        <ThemeToggle />
        {children}
      </div>
    </header>
  )
}
