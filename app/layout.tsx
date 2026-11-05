import type { Metadata } from 'next'
import { Andika, Manrope } from 'next/font/google'
import { DISPLAY_INIT_SCRIPT } from './displayShared'
import './globals.css'

// cyrillic-ext is needed for Kazakh letters (Ә, Ғ, Қ, Ң, Ө, Ұ, Ү, Һ, І)
const manrope = Manrope({
  subsets: ['latin', 'cyrillic', 'cyrillic-ext'],
  display: 'swap',
  variable: '--font-manrope',
})

// Easy-to-read font for the student's display settings (designed by SIL for literacy)
const andika = Andika({
  weight: ['400', '700'],
  subsets: ['latin', 'cyrillic', 'cyrillic-ext'],
  display: 'swap',
  variable: '--font-readable',
  preload: false,
})

const baseUrl = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'http://localhost:3000'

export const metadata: Metadata = {
  metadataBase: new URL(baseUrl),
  title: 'InclusiveTalk — Живые субтитры для глухих студентов',
  description:
    'Веб-приложение для глухих и слабослышащих студентов в учебном классе. Преподаватель говорит — студенты видят субтитры в реальном времени. Работает на трёх языках.',
  keywords: [
    'live captions',
    'deaf students',
    'inclusive education',
    'инклюзивное обучение',
    'субтитры',
  ],
  openGraph: {
    title: 'InclusiveTalk',
    description: 'Живые субтитры для глухих студентов в классе',
    type: 'website',
    images: ['/logorb.png'],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'InclusiveTalk',
    description: 'Живые субтитры для глухих студентов в классе',
    images: ['/logorb.png'],
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="ru" className={`${manrope.variable} ${andika.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem('theme');var d=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';if((s||d)==='dark')document.documentElement.classList.add('dark');${DISPLAY_INIT_SCRIPT.replace(/\n\s*/g, '')}}catch(e){}})()`,
          }}
        />
      </head>
      <body className={`${manrope.className} min-h-full flex flex-col`}>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-3 focus:rounded-lg focus:bg-blue-700 focus:text-white focus:font-semibold"
        >
          Перейти к содержимому
        </a>
        {children}
      </body>
    </html>
  )
}
