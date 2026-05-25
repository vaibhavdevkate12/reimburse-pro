import './globals.css'
import type { Metadata } from 'next'
import { CurrencyProvider } from './CurrencyContext'

export const metadata: Metadata = {
  title: 'ReimbursePro ERP',
  description: 'Enterprise Reimbursement System',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>
        <CurrencyProvider>
          <div className="layout">
            <main className="main-content">
              {children}
            </main>
          </div>
        </CurrencyProvider>
      </body>
    </html>
  )
}
