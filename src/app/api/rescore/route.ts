import { NextResponse } from 'next/server';
import { requireUserId, UnauthenticatedError } from '@/lib/auth';
import { rescoreAllForUser, rescoreForUser } from '@/lib/match/rescore';

export const runtime = 'nodejs';
/**
 * These handlers do real work -- a model call, or scoring a batch of several
 * hundred jobs -- so they ask for more than the platform's default few seconds.
 * 60 is the ceiling on Vercel's Hobby plan; the batching in each handler is what
 * makes the work fit inside it, and each one reports what is left rather than
 * pretending to have finished.
 */
export const maxDuration = 60;

/**
 * Score jobs against the caller's own profile. Costs nothing: the scorer is
 * deterministic arithmetic and never calls a model.
 *
 *   { }                          -> score whatever has no score yet
 *   { mode: 'all', afterId: 0 }  -> re-score everything, one page at a time
 *
 * Both report what is left rather than claiming to have finished, so the client
 * can keep going and the user can see it happening. A single request that tried
 * to score the whole feed would be killed by the platform's timeout somewhere in
 * the middle, and would have no way to say so.
 */
export async function POST(request: Request) {
  let userId: number;
  try {
    userId = await requireUserId();
  } catch (err) {
    if (err instanceof UnauthenticatedError) return NextResponse.json({ error: err.message }, { status: 401 });
    throw err;
  }

  let body: { mode?: unknown; afterId?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // An empty body is the common case: "score what is missing".
  }

  if (body.mode === 'all') {
    const afterId = Number.isInteger(Number(body.afterId)) ? Math.max(0, Number(body.afterId)) : 0;
    const result = await rescoreAllForUser(userId, afterId);
    return NextResponse.json({ ok: true, mode: 'all', ...result });
  }

  const result = await rescoreForUser(userId);
  return NextResponse.json({ ok: true, mode: 'missing', ...result });
}
