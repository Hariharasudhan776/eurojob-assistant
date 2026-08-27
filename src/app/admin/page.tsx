import { requireAdmin } from '@/lib/auth';
import { getAiProvider, listAllUsers } from '@/lib/db/repo';
import { AdminPanel } from '@/components/AdminPanel';

export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const admin = await requireAdmin();
  const [users, provider] = await Promise.all([listAllUsers(), getAiProvider(admin.userId)]);

  return (
    <div className="space-y-6">
      <div className="animate-rise">
        <p className="text-sm font-semibold uppercase tracking-widest text-[var(--color-muted)]">Admin</p>
        <h1 className="font-display mt-1 text-3xl font-extrabold">
          <span className="text-gradient">Control</span> panel
        </h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Approve account requests, manage users and passwords, and choose which AI model each account generates with.
        </p>
      </div>

      <AdminPanel
        users={users.map((u) => ({
          id: u.id,
          email: u.email,
          display_name: u.display_name,
          status: u.status,
          is_admin: u.is_admin,
          ai_provider: u.ai_provider,
          created_at: typeof u.created_at === 'string' ? u.created_at : new Date(u.created_at).toISOString(),
          last_login_at: u.last_login_at
            ? typeof u.last_login_at === 'string'
              ? u.last_login_at
              : new Date(u.last_login_at).toISOString()
            : null,
          has_password: u.has_password,
        }))}
        provider={provider}
        adminId={admin.userId}
      />
    </div>
  );
}
