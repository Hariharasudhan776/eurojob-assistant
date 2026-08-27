import { NextResponse } from 'next/server';
import { setStage, listApplications, STAGES, type Stage } from '@/lib/db/repo';
import { requireUserId, UnauthenticatedError } from '@/lib/auth';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const userId = await requireUserId();
    return NextResponse.json({ applications: await listApplications(userId) });
  } catch (err) {
    if (err instanceof UnauthenticatedError) return NextResponse.json({ error: err.message }, { status: 401 });
    throw err;
  }
}

export async function POST(request: Request) {
  let body: { jobId?: unknown; stage?: unknown; note?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const jobId = Number(body.jobId);
  const stage = String(body.stage ?? '');

  // Validated against the enum here rather than relying on the column's CHECK
  // constraint: a 400 naming the allowed values is a far more useful answer
  // than a 500 carrying a Postgres constraint violation.
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return NextResponse.json({ error: 'jobId must be a positive integer' }, { status: 400 });
  }
  if (!STAGES.includes(stage as Stage)) {
    return NextResponse.json({ error: `stage must be one of: ${STAGES.join(', ')}` }, { status: 400 });
  }
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 4000) : undefined;

  try {
    const userId = await requireUserId();
    const applicationId = await setStage(userId, jobId, stage as Stage, note);
    return NextResponse.json({ ok: true, applicationId });
  } catch (err) {
    if (err instanceof UnauthenticatedError) return NextResponse.json({ error: err.message }, { status: 401 });
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 });
  }
}
