import { NextResponse } from 'next/server';
import { markNotificationsRead } from '@/lib/db/repo';
import { requireUserId, UnauthenticatedError } from '@/lib/auth';

export const runtime = 'nodejs';

/** Mark the caller's own notifications read. Read, never deleted. */
export async function POST() {
  try {
    const userId = await requireUserId();
    const cleared = await markNotificationsRead(userId);
    return NextResponse.json({ ok: true, cleared });
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 });
  }
}
