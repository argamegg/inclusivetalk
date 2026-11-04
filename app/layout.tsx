import type { Metadata } from 'next'
import { Manrope } from 'next/font/google'
import './globals.css'

const manrope = Manrope({
  subsets: ['latin', 'cyrillic'],
  display: 'swap',
  variable: '--font-manrope',
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
    <html lang="ru" className={`${manrope.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var s=localStorage.getItem('theme');var d=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';if((s||d)==='dark')document.documentElement.classList.add('dark')})()`,
          }}
        />
      </head>
      <body className={`${manrope.className} min-h-full flex flex-col`}>{children}</body>
    </html>
  )
}
