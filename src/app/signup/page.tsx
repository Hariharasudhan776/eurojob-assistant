import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/auth';
import { SignupForm } from '@/components/AuthForms';
import { AuthShell } from '@/components/AuthShell';

export const dynamic = 'force-dynamic';

export default async function SignupPage() {
  if (await currentUser()) redirect('/');

  return (
    <AuthShell
      title="Request an account"
      subtitle="Accounts are reviewed before they are activated, so this is a request rather than an instant sign-up."
      footer={
        <div className="glass rounded-2xl p-4">
          <p className="text-xs font-semibold">Why a JSON profile, and not a resume upload</p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--color-muted)]">
            Reading a resume automatically is the step most likely to introduce a mistake nobody
            notices — a wrong date, a skill you do not have. Everything generated here is only as
            truthful as your profile, so the profile is written by you rather than guessed at.
          </p>
        </div>
      }
    >
      <SignupForm />
    </AuthShell>
  );
}
