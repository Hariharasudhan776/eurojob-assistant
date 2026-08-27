import { NextResponse } from 'next/server';
import { requireUserId, UnauthenticatedError } from '@/lib/auth';
import { latestProfile, saveProfile } from '@/lib/db/repo';
import { parseProfileUpload, MAX_UPLOAD_BYTES } from '@/lib/resume/upload';
import { rescoreForUser } from '@/lib/match/rescore';

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
 * Replace your profile with a new version.
 *
 * Versioning is the point, and it is why this creates a NEW version rather than
 * editing the current one: every match records the profile version that produced
 * it, so an old score stays explainable against the facts that were true when it
 * was computed. Nothing is overwritten and nothing is deleted.
 *
 * A new version means no match exists for it yet, so the jobs are re-scored --
 * in bounded batches, with the remainder reported, because a request cannot be
 * relied on to run for a minute.
 */
export async function POST(request: Request) {
  let userId: number;
  try {
    userId = await requireUserId();
  } catch (err) {
    if (err instanceof UnauthenticatedError) return NextResponse.json({ error: err.message }, { status: 401 });
    throw err;
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Send this as a form submission with a profile file attached.' }, { status: 400 });
  }

  const file = form.get('profile');
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: 'Attach a profile JSON file.' }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: `The limit is ${Math.round(MAX_UPLOAD_BYTES / 1024)} KB.` }, { status: 413 });
  }

  const current = await latestProfile(userId);
  const nextVersion = (current?.data.version ?? 0) + 1;

  const parsed = parseProfileUpload(await file.text(), nextVersion);
  if (!parsed.profile) {
    return NextResponse.json({ error: 'That profile could not be accepted.', details: parsed.errors }, { status: 422 });
  }

  // A file that carries an old version number would silently overwrite that
  // version's row instead of creating a new one, which would rewrite history.
  const profile =
    current && parsed.profile.version <= current.data.version
      ? { ...parsed.profile, version: nextVersion }
      : parsed.profile;

  const profileId = await saveProfile(userId, profile);
  const caught = await rescoreForUser(userId);

  return NextResponse.json({
    ok: true,
    profileId,
    version: profile.version,
    filledIn: parsed.filledIn,
    scored: caught.scored,
    remaining: caught.remaining,
  });
}
