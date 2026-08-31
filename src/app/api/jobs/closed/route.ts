import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUserId, UnauthenticatedError } from '@/lib/auth';
import { reportJobGone, reopenJob } from '@/lib/db/repo';

export const runtime = 'nodejs';

/**
 * "This posting is no longer available."
 *
 * The only closure signal with certainty behind it. Everything else the app
 * knows about whether a job is still open is inference from dates -- the three
 * mechanical checks that would have been better were measured against the live
 * feed and none of them works (see db/006_job_lifecycle.sql). A person who
 * clicked through and saw the posting gone knows something the app cannot find
 * out for itself.
 *
 * Jobs are shared rows (§4), so this closes the posting for everyone rather than
 * hiding it for one account -- the same reasoning that makes a collected posting
 * public data in the first place. It is a report about the world, not a
 * preference. And it is reversible from the same control, because a misclick
 * must not cost anyone a job.
 *
 * Requires a session, so postings cannot be closed anonymously.
 */
const Body = z.object({
  jobId: z.number().int().positive(),
  gone: z.boolean(),
});

export async function POST(request: Request) {
  try {
    await requireUserId();

    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'jobId and gone are required' }, { status: 400 });
    }

    const { jobId, gone } = parsed.data;
    if (gone) await reportJobGone(jobId);
    else await reopenJob(jobId);

    return NextResponse.json({ ok: true, closed: gone });
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 });
  }
}
