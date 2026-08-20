import { NextResponse } from 'next/server';
import { getJob, latestProfile, saveAiSummary, saveDocument } from '@/lib/db/repo';
import { currentUserId } from '@/lib/session';
import { scoreJob } from '@/lib/match/score';
import { aiRuntime } from '@/lib/ai/runtime';
import { AiClient } from '@/lib/ai/client';
import { BudgetExceededError } from '@/lib/ai/budget';
import { DEFAULT_SEARCH } from '@/lib/search-config';
import { TONES, type Tone } from '@/lib/ai/prompts';
import type { NormalisedJob } from '@/lib/jobs/types';

/**
 * The only route that spends money.
 *
 * Every path through it goes via aiRuntime(), which attaches the cache and the
 * spend caps, so there is no way to reach the API from the UI without a brake in
 * front. A BudgetExceededError is returned as 429 with the reason, because it is
 * a deliberate refusal rather than a server fault.
 */
export async function POST(request: Request) {
  if (!AiClient.isConfigured()) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY is not set in .env. Scores work without it; generation does not.' },
      { status: 400 }
    );
  }

  let body: { jobId?: unknown; kind?: unknown; tone?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const jobId = Number(body.jobId);
  const kind = String(body.kind ?? '');
  if (!Number.isInteger(jobId) || jobId <= 0) {
    return NextResponse.json({ error: 'jobId must be a positive integer' }, { status: 400 });
  }
  if (!['explain', 'cover_letter', 'resume'].includes(kind)) {
    return NextResponse.json({ error: 'kind must be explain, cover_letter, or resume' }, { status: 400 });
  }

  const tone = (typeof body.tone === 'string' && body.tone in TONES ? body.tone : 'professional') as Tone;

  try {
    const userId = await currentUserId();
    const [job, profile] = await Promise.all([getJob(userId, jobId), latestProfile(userId)]);
    if (!job) return NextResponse.json({ error: 'job not found' }, { status: 404 });
    if (!profile) return NextResponse.json({ error: 'no profile stored; run npm run db:migrate' }, { status: 400 });

    const normalised = toNormalised(job);
    const match = scoreJob(profile.data, normalised, { preferredCountries: DEFAULT_SEARCH.countries });

    const { client, services } = aiRuntime(profile.data);
    const before = client.stats.estimatedCostUsd;

    if (kind === 'explain') {
      const result = await services.explainMatch(normalised, match);
      await saveAiSummary(jobId, profile.id, { ...result.output, violations: result.violations, safe: result.safe }, client.model);
      return respond(client, before, result.violations);
    }

    if (kind === 'cover_letter') {
      const result = await services.writeCoverLetter(normalised, match, tone);
      await saveDocument({
        userId, jobId, profileId: profile.id, kind: 'cover_letter', tone,
        content: result.output, provenance: { claimsMade: result.output.claimsMade, violations: result.violations },
        model: client.model,
      });
      return respond(client, before, result.violations);
    }

    const result = await services.tailorResume(normalised, match);
    await saveDocument({
      userId, jobId, profileId: profile.id, kind: 'resume', tone: null,
      content: result.output, provenance: { provenance: result.output.provenance, violations: result.violations },
      model: client.model,
    });
    return respond(client, before, result.violations);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      return NextResponse.json({ error: err.message, scope: err.scope }, { status: 429 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 });
  }
}

function respond(client: ReturnType<typeof aiRuntime>['client'], before: number, violations: { severity: string; detail: string }[]) {
  const costUsd = client.stats.estimatedCostUsd - before;
  return NextResponse.json({
    ok: true,
    costUsd,
    // Zero cost with no call means it came from the cache -- worth telling the
    // user, so a free action does not look like a billed one.
    fromCache: costUsd === 0,
    violations,
    blocking: violations.filter((v) => v.severity === 'blocking').length,
  });
}

/** Rebuild the normalised shape from a stored row so scoring has one code path. */
function toNormalised(job: Awaited<ReturnType<typeof getJob>> & object): NormalisedJob {
  return {
    sourceSlug: job.source_slug,
    sourceJobId: String(job.id),
    url: job.url,
    title: job.title,
    company: job.company,
    country: job.country,
    city: job.city,
    remote: job.remote as NormalisedJob['remote'],
    employmentType: job.employment_type,
    salaryMin: job.salary_min,
    salaryMax: job.salary_max,
    salaryCurrency: job.salary_currency,
    description: job.description,
    descriptionComplete: job.description_complete,
    languages: job.languages ?? [],
    visaSponsorship: job.visa_sponsorship as NormalisedJob['visaSponsorship'],
    relocationSupport: job.relocation_support as NormalisedJob['relocationSupport'],
    postedAt: job.posted_at ? new Date(job.posted_at) : null,
    raw: {},
  };
}
