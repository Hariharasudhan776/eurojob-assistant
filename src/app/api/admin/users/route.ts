import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { requireAdminId, ForbiddenError, UnauthenticatedError, hashPassword } from '@/lib/auth';
import { setAiProvider, setUserPasswordById, setUserStatus } from '@/lib/db/repo';

export const runtime = 'nodejs';

/**
 * Admin actions on accounts. Every branch is behind requireAdminId(), so a
 * non-admin gets 403 and an anonymous caller gets 401 — the guard is the only
 * thing standing between a normal user and everyone else's account, so it runs
 * first, before the body is even read.
 */
export async function POST(request: Request) {
  try {
    await requireAdminId();

    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
      userId?: unknown;
      provider?: unknown;
    };
    const action = String(body.action ?? '');
    const userId = Number(body.userId);

    if (action === 'set_provider') {
      const provider = body.provider === 'gemini' ? 'gemini' : 'claude';
      const adminId = await requireAdminId();

      /**
       * Which model an account generates with, set per account by the admin.
       *
       * It used to set the provider on the admin's own account only, on the
       * assumption that theirs was the only one generating. That stopped being
       * true the moment a second person was approved — and the cost lands
       * entirely on the owner, because there is one `ANTHROPIC_API_KEY` for the
       * whole deployment. Every account left on Claude spends the owner's money
       * up to its own $2/day cap.
       *
       * Omitting `userId` still means "mine", so the existing control keeps
       * working; supplying one sets that account instead. Both go through
       * requireAdminId(), so this stays an owner's decision — no user can move
       * themselves onto the paid model, and there is deliberately no control
       * anywhere in the user-facing app that would let them.
       */
      const target = Number.isInteger(Number(body.userId)) && Number(body.userId) > 0 ? Number(body.userId) : adminId;
      await setAiProvider(target, provider);
      return NextResponse.json({ ok: true, provider, userId: target });
    }

    if (!Number.isInteger(userId) || userId <= 0) {
      return NextResponse.json({ error: 'userId must be a positive integer' }, { status: 400 });
    }

    if (action === 'approve') {
      await setUserStatus(userId, 'active');
      return NextResponse.json({ ok: true, status: 'active' });
    }
    if (action === 'reject') {
      await setUserStatus(userId, 'rejected');
      return NextResponse.json({ ok: true, status: 'rejected' });
    }
    if (action === 'reset_password') {
      // A readable, strong one-time password. Shown to the admin ONCE to pass on;
      // there is no email reset, so this is how a locked-out user gets back in.
      const password = randomBytes(9).toString('base64url');
      await setUserPasswordById(userId, await hashPassword(password));
      return NextResponse.json({ ok: true, password });
    }

    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  } catch (err) {
    if (err instanceof UnauthenticatedError) return NextResponse.json({ error: err.message }, { status: 401 });
    if (err instanceof ForbiddenError) return NextResponse.json({ error: err.message }, { status: 403 });
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 });
  }
}
