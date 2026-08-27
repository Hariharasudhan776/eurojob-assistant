import { NextResponse } from 'next/server';
import { getAiProvider, getJob, latestProfile, saveAiSummary, saveDocument } from '@/lib/db/repo';
import { requireUserId, UnauthenticatedError } from '@/lib/auth';
import { scoreJob } from '@/lib/match/score';
import { targetCountriesFor } from '@/lib/match/rescore';
import { aiRuntime } from '@/lib/ai/runtime';
import { AiClient } from '@/lib/ai/client';
import { BudgetExceededError } from '@/lib/ai/budget';
import { TONES, type Tone } from '@/lib/ai/prompts';
import type { NormalisedJob } from '@/lib/jobs/types';
import { buildMirrorPlan } from '@/lib/resume/mirror';
import { auditResume, type ResumeAudit } from '@/lib/resume/audit';
import { renderResumeText } from '@/lib/docs/render';
import { jobRowToNormalised as toNormalised } from '@/lib/jobs/from-row';

export const runtime = 'nodejs';
/**
 * These handlers do real work -- a model call, or scoring a batch of several
 * hundred jobs -- so they ask for more than the platform's default few seconds.
 *
 * 300 rather than 60, because 60 was not enough and the failure was ugly:
 * tailoring a resume is a 16,000-token generation from a thinking model, which
 * measured 46s of model time on its own before the database round trips, the
 * verification pass and the document write. Past 60s the platform killed the
 * function and answered with a plain-text error page, so the browser's
 * `res.json()` reported `Unexpected token 'A', "An error o"...` -- a JSON parse
 * error standing in for "this took too long".
 *
 * 300 is the ceiling this project actually has (Fluid compute is enabled, whose
 * default function timeout is 300s); the old comment's "60 is the ceiling on
 * Hobby" was the pre-Fluid limit. The batching in each handler still matters --
 * it is what keeps the scoring routes far inside this -- and each one reports
 * what is left rather than pretending to have finished.
 */
export const maxDuration = 300;

/**
 * The only route that spends money.
 *
 * Every path through it goes via aiRuntime(), which attaches the cache and this
 * user's own spend caps, so there is no way to reach the API from the UI without
 * a brake in front. A BudgetExceededError is returned as 429 with the reason,
 * because it is a deliberate refusal rather than a server fault.
 *
 * The cap is per user (`ai_spend` rows, not one shared file), so one person
 * generating tailored resumes all afternoon cannot spend anybody else's day.
 */
export async function POST(request: Request) {
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
    const userId = await requireUserId();
    const [job, profile, preferredCountries, provider] = await Promise.all([
      getJob(userId, jobId),
      latestProfile(userId),
      targetCountriesFor(userId),
      getAiProvider(userId),
    ]);

    // The key that has to exist depends on which provider this account is set to.
    const chosen = (provider === 'gemini' ? 'gemini' : 'claude') as 'gemini' | 'claude';
    if (!AiClient.isConfigured(chosen)) {
      return NextResponse.json(
        {
          error:
            chosen === 'gemini'
              ? 'GEMINI_API_KEY is not set. Add it, or switch the provider back to Claude in the admin panel.'
              : 'ANTHROPIC_API_KEY is not set. Scores work without it; generation does not.',
        },
        { status: 400 }
      );
    }

    if (!job) return NextResponse.json({ error: 'job not found' }, { status: 404 });
    if (!profile) {
      return NextResponse.json(
        { error: 'You have no profile yet. Upload one from My Profile.' },
        { status: 400 }
      );
    }

    const normalised = toNormalised(job);
    const match = scoreJob(profile.data, normalised, { preferredCountries });

    const { client, services, guard } = await aiRuntime(userId, profile.data, chosen);
    const before = client.stats.estimatedCostUsd;

    if (kind === 'explain') {
      const result = await services.explainMatch(normalised, match);
      await saveAiSummary(jobId, profile.id, { ...result.output, violations: result.violations, safe: result.safe }, client.model);
      return await respond(client, guard, before, result.violations);
    }

    if (kind === 'cover_letter') {
      const result = await services.writeCoverLetter(normalised, match, tone);
      await saveDocument({
        userId, jobId, profileId: profile.id, kind: 'cover_letter', tone,
        content: result.output, provenance: { claimsMade: result.output.claimsMade, violations: result.violations },
        model: client.model,
      });
      return await respond(client, guard, before, result.violations);
    }

    const result = await services.tailorResume(normalised, match);

    // Grade the document that was actually produced, not the profile it came
    // from. The pre-flight ATS check reports whether the candidate *could*
    // match this posting; this reports whether the page in front of them
    // *does* -- which is the question seven rejected applications were really
    // asking. It is deterministic and free, so it runs on every generation.
    const mirror = buildMirrorPlan(match.requirements.required, match.requirements.preferred, profile.data);
    const audit = auditResume(
      profile.data,
      result.output,
      mirror,
      normalised,
      renderResumeText(profile.data, result.output)
    );

    await saveDocument({
      userId, jobId, profileId: profile.id, kind: 'resume', tone: null,
      content: result.output,
      provenance: { provenance: result.output.provenance, violations: result.violations, audit },
      model: client.model,
    });
    return await respond(client, guard, before, result.violations, audit);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return NextResponse.json({ error: err.message }, { status: 401 });
    }
    if (err instanceof BudgetExceededError) {
      return NextResponse.json({ error: err.message, scope: err.scope }, { status: 429 });
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 });
  }
}

async function respond(
  client: Awaited<ReturnType<typeof aiRuntime>>['client'],
  guard: Awaited<ReturnType<typeof aiRuntime>>['guard'],
  before: number,
  violations: { severity: string; detail: string }[],
  audit?: ResumeAudit
) {
  // Spend is written durably BEFORE responding. On a serverless host the process
  // can be frozen the moment the response is sent, and a charge that never
  // reached the ledger is a cap that quietly stopped applying.
  await guard.flush();

  const costUsd = client.stats.estimatedCostUsd - before;
  return NextResponse.json({
    ok: true,
    costUsd,
    provider: client.provider,
    // Zero cost with no call means it came from the cache -- worth telling the
    // user, so a free action does not look like a billed one. Gemini is free
    // even on a real call, so a $0 there is NOT a cache hit.
    fromCache: costUsd === 0 && client.provider === 'claude',
    spentTodayUsd: guard.spentLast24h(),
    violations,
    blocking: violations.filter((v) => v.severity === 'blocking').length,
    // Present only for a resume: the recruiter-scan grade for the document just
    // generated, shown next to the download.
    audit,
  });
}
