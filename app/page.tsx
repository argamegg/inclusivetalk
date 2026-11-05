import Image from 'next/image'
import Link from 'next/link'
import SiteHeader from './components/SiteHeader'

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col bg-white dark:bg-gray-950">
      <SiteHeader />

      <main id="main" className="flex-1">
        {/* Hero */}
        <section className="flex flex-col items-center text-center px-6 py-16 md:py-24">
          <div className="max-w-2xl mx-auto space-y-8">
            <Image
              src="/logorb.png"
              alt=""
              width={200}
              height={200}
              className="mx-auto rounded-3xl shadow-lg dark:brightness-0 dark:invert"
              priority
            />

            <div className="space-y-4">
              <h1 className="text-4xl md:text-5xl font-bold text-gray-900 dark:text-white tracking-tight">
                InclusiveTalk
              </h1>
              <p className="text-xl md:text-2xl text-gray-700 dark:text-gray-200 font-medium">
                Живые субтитры для глухих и слабослышащих студентов
              </p>
              <p className="text-base text-gray-700 dark:text-gray-300 leading-relaxed max-w-lg mx-auto">
                Веб-приложение для классов где учатся слышащие и неслышащие студенты.
                Преподаватель ведёт урок голосом — студенты получают субтитры на своих
                устройствах в реальном времени. Работает на русском, казахском и английском.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                href="/teacher"
                className="px-8 py-4 bg-blue-700 hover:bg-blue-800 active:bg-blue-900 text-white text-lg font-semibold rounded-2xl transition-colors text-center"
              >
                Я преподаватель
              </Link>
              <Link
                href="/student"
                className="px-8 py-4 border-2 border-gray-400 dark:border-gray-500 hover:border-blue-700 dark:hover:border-blue-400 text-gray-900 dark:text-white hover:text-blue-800 dark:hover:text-blue-300 text-lg font-semibold rounded-2xl transition-colors text-center"
              >
                Я студент
              </Link>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section className="px-6 py-16 bg-gray-50 dark:bg-gray-900">
          <div className="max-w-5xl mx-auto">
            <h2 className="text-3xl font-bold text-gray-900 dark:text-white text-center mb-12">
              Как это работает
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl p-8 shadow-sm">
                <div aria-hidden="true" className="text-5xl mb-4">🎤</div>
                <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-3">
                  1. Преподаватель начинает урок
                </h3>
                <p className="text-gray-700 dark:text-gray-300 leading-relaxed">
                  Открывает страницу преподавателя, выбирает язык, нажимает «Начать урок»
                  и говорит как обычно.
                </p>
              </div>

              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl p-8 shadow-sm">
                <div aria-hidden="true" className="text-5xl mb-4">🔢</div>
                <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-3">
                  2. Делится кодом урока
                </h3>
                <p className="text-gray-700 dark:text-gray-300 leading-relaxed">
                  Система генерирует 6-значный код. Преподаватель сообщает его студентам
                  устно или на доске.
                </p>
              </div>

              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-2xl p-8 shadow-sm">
                <div aria-hidden="true" className="text-5xl mb-4">📱</div>
                <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-3">
                  3. Студенты читают субтитры
                </h3>
                <p className="text-gray-700 dark:text-gray-300 leading-relaxed">
                  Студенты вводят код на своих телефонах и видят что говорит преподаватель
                  в реальном времени.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-100 dark:border-gray-800 px-6 py-6">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-gray-600 dark:text-gray-300">
          <span>© 2026 InclusiveTalk. Создано преподавателем для студентов.</span>
          <a
            href="https://github.com/argamegg/inclusivetalk"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-gray-900 dark:hover:text-white transition-colors"
          >
            GitHub<span className="sr-only"> (откроется в новой вкладке)</span>
          </a>
        </div>
      </footer>
    </div>
  )
}
