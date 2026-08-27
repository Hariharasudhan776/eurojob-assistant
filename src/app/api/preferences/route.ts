import { NextResponse } from 'next/server';
import { requireUserId, UnauthenticatedError } from '@/lib/auth';
import { setTargetCountries } from '@/lib/db/repo';

export const runtime = 'nodejs';

/**
 * Set the countries the location component treats as targets.
 *
 * Collection is global; this is about scoring. Changing it makes existing scores
 * stale, which the response says plainly rather than leaving the user with
 * numbers that no longer reflect their own preference -- re-scoring is a separate,
 * explicit step (`/api/rescore` with mode 'all').
 */
export async function POST(request: Request) {
  let userId: number;
  try {
    userId = await requireUserId();
  } catch (err) {
    if (err instanceof UnauthenticatedError) return NextResponse.json({ error: err.message }, { status: 401 });
    throw err;
  }

  let body: { countries?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const raw = Array.isArray(body.countries) ? body.countries : [];
  const countries = raw.filter((c): c is string => typeof c === 'string');
  if (countries.length !== raw.length) {
    return NextResponse.json({ error: 'countries must be an array of ISO 3166-1 alpha-2 codes' }, { status: 400 });
  }

  await setTargetCountries(userId, countries);
  return NextResponse.json({
    ok: true,
    countries,
    note: 'Saved. Existing scores were computed against the previous list — re-score to bring them up to date.',
  });
}
