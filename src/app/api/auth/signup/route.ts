import { NextResponse } from 'next/server';
import { Credentials, hashPassword } from '@/lib/auth';
import { createUser, saveCvText, saveProfile } from '@/lib/db/repo';
import { parseProfileUpload, MAX_UPLOAD_BYTES } from '@/lib/resume/upload';
import { extractCvText, MAX_CV_BYTES } from '@/lib/resume/extract';

// bcrypt is native-ish and the pool is a Node client: this route cannot run on
// the edge runtime.
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
 * Create an account from an email, a password, and a profile JSON file.
 *
 * The profile is required at signup rather than optional afterwards, because
 * every other feature is a function of it: there is nothing to score against, no
 * evidence to write from, and no dashboard to show without one. Asking for it
 * later would mean an account whose first experience is an empty app.
 *
 * The upload is validated with the same schema the local file always used, so
 * the rule that made the file trustworthy survives the move to HTTP: **a skill
 * with no `evidence` is rejected.** Errors name the exact JSON path, because
 * "invalid profile" is not something a user can act on.
 */
export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Send this as a form submission with a profile file attached.' }, { status: 400 });
  }

  const credentials = Credentials.safeParse({
    email: form.get('email'),
    password: form.get('password'),
  });
  if (!credentials.success) {
    return NextResponse.json(
      { error: credentials.error.issues.map((i) => i.message).join(' ') },
      { status: 400 }
    );
  }

  const displayNameRaw = form.get('displayName');
  const displayName = typeof displayNameRaw === 'string' && displayNameRaw.trim() ? displayNameRaw.trim().slice(0, 120) : null;

  /**
   * Two ways in, and the CV is the one people can actually use.
   *
   * Only the free half of the pipeline runs here. Extracting text from a PDF is
   * deterministic and costs nothing; turning it into a profile is a model call,
   * and running that for an anonymous visitor would be an open tap on the API
   * budget for an account that may never be approved. So the text is stored, and
   * the drafting happens after approval, on the user's own account and cap.
   *
   * The JSON path is kept for anyone who wants exact control, and is unchanged.
   */
  const cv = form.get('cv');
  const file = form.get('profile');

  const hasCv = cv instanceof File && cv.size > 0;
  const hasJson = file instanceof File && file.size > 0;

  if (!hasCv && !hasJson) {
    return NextResponse.json(
      { error: 'Attach your CV as a PDF or Word document.' },
      { status: 400 }
    );
  }

  let cvText: { text: string; filename: string } | null = null;
  let parsed: ReturnType<typeof parseProfileUpload> | null = null;

  if (hasCv) {
    if (cv.size > MAX_CV_BYTES) {
      return NextResponse.json(
        { error: `That file is ${(cv.size / 1024 / 1024).toFixed(1)}MB; the limit is 8MB.` },
        { status: 413 }
      );
    }
    const extracted = await extractCvText(cv.name, new Uint8Array(await cv.arrayBuffer()));
    // Checked BEFORE the account exists, so an unreadable CV does not leave a
    // half-made account behind -- the same rule the JSON path has always had.
    if (!extracted.text || extracted.errors.length) {
      return NextResponse.json(
        { error: extracted.errors[0] ?? 'No text could be read from that file.', details: extracted.errors },
        { status: 422 }
      );
    }
    cvText = { text: extracted.text, filename: cv.name };
  } else if (hasJson) {
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `That file is ${Math.round(file.size / 1024)} KB; the limit is ${Math.round(MAX_UPLOAD_BYTES / 1024)} KB.` },
        { status: 413 }
      );
    }
    parsed = parseProfileUpload(await file.text());
    if (!parsed.profile) {
      return NextResponse.json({ error: 'That profile could not be accepted.', details: parsed.errors }, { status: 422 });
    }
  }

  const passwordHash = await hashPassword(credentials.data.password);
  const userId = await createUser(credentials.data.email, passwordHash, displayName);
  if (userId === null) {
    return NextResponse.json({ error: 'An account already exists for that email. Sign in instead.' }, { status: 409 });
  }

  if (parsed?.profile) await saveProfile(userId, parsed.profile);
  if (cvText) await saveCvText(userId, cvText.text, cvText.filename);

  // Deliberately NOT signed in. New accounts are created 'pending' and must be
  // approved by an admin before they can sign in — so this returns a "request
  // received" acknowledgement rather than a session. Their profile is saved so
  // that, once approved, their feed can be scored and they land on a full app.
  // Scoring is skipped here on purpose: it would spend compute on an account
  // that may never be approved, and the first sign-in / Profile page fills it in.
  return NextResponse.json({
    ok: true,
    pending: true,
    fromCv: Boolean(cvText),
    filledIn: parsed?.filledIn ?? [],
  });
}
