import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { SignupForm } from '@/components/AuthForms';
import { Card } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function SignupPage() {
  if (await currentUser()) redirect('/');

  return (
    <div className="mx-auto max-w-lg space-y-4 py-8">
      <div>
        <h1 className="text-lg font-semibold">Create an account</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          You bring your profile as JSON. The app scores the whole job feed against it — that part is free, because
          scoring is arithmetic, not a model call.
        </p>
      </div>
      <Card>
        <SignupForm />
      </Card>
      <Card title="Why JSON, and not a resume upload">
        <p className="text-sm text-[var(--color-muted)]">
          Parsing a resume automatically is the step most likely to introduce a mistake you would never notice — a
          wrong date, a skill you do not have. Everything this app generates is only as truthful as your profile, so
          the profile is written by you, not inferred.
        </p>
      </Card>
    </div>
  );
}
