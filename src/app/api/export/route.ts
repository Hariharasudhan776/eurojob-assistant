import { getDocument, getJob, latestProfile } from '@/lib/db/repo';
import { requireUserId, UnauthenticatedError } from '@/lib/auth';
import { renderCoverLetter, renderResume, renderResumeText } from '@/lib/docs/render';
import type { CoverLetter, TailoredResume } from '@/lib/ai/schemas';

/**
 * Download a generated document as DOCX (or plain text with format=txt).
 *
 * It renders from the stored content rather than re-calling the model, so
 * pressing download twice costs nothing and always produces the same file as
 * the version that was reviewed on screen.
 */
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const jobId = Number(url.searchParams.get('jobId'));
  const kind = url.searchParams.get('kind');
  const format = url.searchParams.get('format') ?? 'docx';

  if (!Number.isInteger(jobId) || jobId <= 0) {
    return new Response('jobId must be a positive integer', { status: 400 });
  }
  if (kind !== 'resume' && kind !== 'cover_letter') {
    return new Response('kind must be resume or cover_letter', { status: 400 });
  }

  let userId: number;
  try {
    userId = await requireUserId();
  } catch (err) {
    if (err instanceof UnauthenticatedError) return new Response(err.message, { status: 401 });
    throw err;
  }
  const [job, profile, document] = await Promise.all([
    getJob(userId, jobId),
    latestProfile(userId),
    getDocument(userId, jobId, kind),
  ]);

  if (!job) return new Response('job not found', { status: 404 });
  if (!profile) return new Response('no profile stored; run npm run db:migrate', { status: 400 });
  if (!document) {
    return new Response(
      `No ${kind === 'resume' ? 'tailored resume' : 'cover letter'} has been generated for this job yet. ` +
        'Generate it first from the job page.',
      { status: 404 }
    );
  }

  const safeCompany = job.company.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const base = `${profile.data.name.replace(/\s+/g, '_')}_${kind === 'resume' ? 'Resume' : 'CoverLetter'}_${safeCompany}`;

  if (format === 'txt') {
    if (kind !== 'resume') return new Response('txt export is only available for resumes', { status: 400 });
    const text = renderResumeText(profile.data, document.content as TailoredResume);
    return new Response(text, {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="${base}.txt"`,
      },
    });
  }

  const buffer =
    kind === 'resume'
      ? await renderResume(profile.data, document.content as TailoredResume, job.title, job.company)
      : await renderCoverLetter(profile.data, document.content as CoverLetter, job.title, job.company);

  return new Response(new Uint8Array(buffer), {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'content-disposition': `attachment; filename="${base}.docx"`,
      'content-length': String(buffer.length),
    },
  });
}
