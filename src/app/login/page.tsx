import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { LoginForm } from '@/components/AuthForms';
import { AuthShell } from '@/components/AuthShell';

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
    <AuthShell title="Sign in" subtitle="Welcome back. Pick up where you left off.">
      {/* Only same-origin paths are followed, so ?next= cannot be used to
          bounce someone to another site after signing in. */}
      <LoginForm next={next && next.startsWith('/') ? next : undefined} />
    </AuthShell>
  );
}
