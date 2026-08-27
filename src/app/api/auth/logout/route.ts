import { NextResponse } from 'next/server';
import { endSession } from '@/lib/auth';

export const runtime = 'nodejs';

/**
 * Sign out.
 *
 * The session row is revoked server-side, not just forgotten client-side:
 * clearing a cookie only stops the browser from sending a token that would still
 * be valid if anyone else had a copy of it.
 */
export async function POST() {
  await endSession();
  return NextResponse.json({ ok: true });
}
