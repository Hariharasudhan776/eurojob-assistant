import type { Metadata } from 'next';
import Link from 'next/link';
import { Brand } from '@/components/Brand';
import { Plus_Jakarta_Sans, Space_Grotesk } from 'next/font/google';
import { currentUser } from '@/lib/auth';
import { pendingUserCount } from '@/lib/db/repo';
import { SignOutButton } from '@/components/AuthForms';
import { Nav } from '@/components/Nav';
import './globals.css';

const body = Plus_Jakarta_Sans({ subsets: ['latin'], variable: '--font-body', display: 'swap' });
const display = Space_Grotesk({ subsets: ['latin'], variable: '--font-display', display: 'swap' });

export const metadata: Metadata = {
  title: 'Job Assistant',
  description: 'Global job search, matching, and application tracking',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The navigation is hidden when nobody is signed in, so the login screen does
  // not offer links that will only bounce back to it.
  const user = await currentUser();
  // Only an admin needs the pending count, and only then is it worth a query.
  const pending = user?.isAdmin ? await pendingUserCount() : 0;

  return (
    <html lang="en" className={`${body.variable} ${display.variable}`}>
      <body className="min-h-screen">
        <header className="sticky top-0 z-20 border-b border-white/10 bg-[rgba(10,7,16,0.7)] backdrop-blur-xl">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-5 py-3">
            <Link href="/" className="shrink-0">
              <Brand size="md" gradientId="brandNav" />
            </Link>
            {user && <Nav isAdmin={user.isAdmin} pending={pending} />}
            <div className="ml-auto flex items-center gap-3 text-sm">
              {user ? (
                <>
                  <span className="hidden rounded-full bg-white/5 px-3 py-1 text-xs text-[var(--color-muted)] sm:inline">
                    {user.displayName ?? user.email}
                  </span>
                  <SignOutButton />
                </>
              ) : (
                <>
                  <Link href="/login" className="text-[var(--color-muted)] hover:text-[var(--color-fg)]">
                    Sign in
                  </Link>
                  <Link
                    href="/signup"
                    className="rounded-full px-3 py-1.5 font-bold text-white"
                    style={{ backgroundImage: 'var(--grad-brand)' }}
                  >
                    Create account
                  </Link>
                </>
              )}
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-7xl px-5 py-8">{children}</main>
      </body>
    </html>
  );
}
