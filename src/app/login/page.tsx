import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { LoginForm } from '@/components/AuthForms';
import { Card } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (await currentUser()) redirect('/');

  const params = await searchParams;
  const nextRaw = params.next;
  const next = Array.isArray(nextRaw) ? nextRaw[0] : nextRaw;

  return (
    <div className="mx-auto max-w-sm space-y-4 py-8">
      <div>
        <h1 className="text-lg font-semibold">Sign in</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Your profile, your scores, your documents, and your AI spend are yours alone — every account is separate.
        </p>
      </div>
      <Card>
        {/* Only same-origin paths are followed, so ?next= cannot be used to
            bounce someone to another site after signing in. */}
        <LoginForm next={next && next.startsWith('/') ? next : undefined} />
      </Card>
    </div>
  );
}
