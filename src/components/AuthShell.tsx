import type { ReactNode } from 'react';
import { Brand } from '@/components/Brand';

/**
 * The frame around sign in and sign up.
 *
 * These two screens carry more weight than their size suggests: they are the
 * only thing a new user sees before deciding whether the rest is worth their
 * time, and the previous version was a bare heading and a box floating at the
 * top-left of an empty page. It looked like a staging environment, which is a
 * poor advertisement for an application whose whole pitch is that it is careful
 * with your data.
 *
 * The three trust lines are not decoration either. Every one of them answers a
 * question a stranger actually has before typing a password into an unfamiliar
 * site — who can see my data, what does this cost me, and what happens to my
 * resume — and each is a claim the codebase can back: per-user isolation is
 * enforced at the SQL layer, scoring never calls a model, and nothing is
 * generated that the profile cannot evidence.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="relative mx-auto flex min-h-[calc(100vh-8rem)] max-w-5xl items-center justify-center px-4 py-10">
      {/* Two soft gradient washes behind the card. Pointer-events off so they
          can never swallow a click on the form. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-0 -z-10 h-72 w-72 -translate-x-1/2 rounded-full opacity-25 blur-3xl"
        style={{ backgroundImage: 'var(--grad-brand)' }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 right-8 -z-10 h-56 w-56 rounded-full opacity-15 blur-3xl"
        style={{ backgroundImage: 'var(--grad-blue)' }}
      />

      <div className="grid w-full gap-10 md:grid-cols-[1.05fr_1fr] md:items-center">
        {/* The pitch. Hidden on small screens, where the form is the only thing
            worth the space. */}
        <div className="hidden md:block">
          <Brand size="lg" gradientId="brandAuth" />
          <h1 className="font-display mt-6 text-3xl font-extrabold leading-tight">
            Every job in Europe,
            <br />
            scored against <span className="text-gradient">your</span> experience.
          </h1>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-[var(--color-muted)]">
            Thousands of postings collected daily, matched by what you have actually done, and
            tailored into a resume that uses the employer&apos;s own words — never words you cannot
            back up.
          </p>

          <ul className="mt-7 space-y-3">
            <TrustLine
              title="Your data is yours"
              body="Profiles, documents and spend are separated per account in the database itself, not by a filter."
            />
            <TrustLine
              title="Scoring is free and explainable"
              body="Six weighted components computed in code. Every number shows the facts behind it."
            />
            <TrustLine
              title="Nothing is invented"
              body="Every skill needs evidence, and generated text is checked against your profile before you see it."
            />
          </ul>
        </div>

        <div className="w-full">
          {/* The mark repeats on small screens, where the pitch column is gone. */}
          <div className="mb-6 md:hidden">
            <Brand size="md" gradientId="brandAuthSmall" />
          </div>

          <div className="glass rounded-2xl p-6 shadow-2xl ring-1 ring-white/10">
            <h2 className="font-display text-xl font-bold">{title}</h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">{subtitle}</p>
            <div className="mt-5">{children}</div>
          </div>

          {footer && <div className="mt-4">{footer}</div>}
        </div>
      </div>
    </div>
  );
}

function TrustLine({ title, body }: { title: string; body: string }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="mt-1 h-5 w-5 shrink-0 rounded-md"
        style={{ backgroundImage: 'var(--grad-green)' }}
      />
      <span>
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block text-xs leading-relaxed text-[var(--color-muted)]">{body}</span>
      </span>
    </li>
  );
}
