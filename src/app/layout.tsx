import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'EuroJob Assistant',
  description: 'European job search, matching, and application tracking',
};

const NAV = [
  { href: '/', label: 'Dashboard' },
  { href: '/jobs', label: 'Jobs' },
  { href: '/jobs?recommendation=highly_recommended', label: 'Recommended' },
  { href: '/applications', label: 'Applications' },
  { href: '/profile', label: 'My Profile' },
  { href: '/settings', label: 'Settings' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <header className="border-b border-[var(--color-line)] bg-[var(--color-panel)]">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3">
            <Link href="/" className="text-sm font-semibold tracking-tight">
              EuroJob<span className="text-[var(--color-accent)]">Assistant</span>
            </Link>
            <nav className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
              {NAV.map((item) => (
                <Link
                  key={item.label}
                  href={item.href}
                  className="text-[var(--color-muted)] transition-colors hover:text-[var(--color-fg)]"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-5 py-6">{children}</main>
      </body>
    </html>
  );
}
