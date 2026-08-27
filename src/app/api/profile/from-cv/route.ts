import { NextResponse } from 'next/server';
import { getAiProvider, latestProfile } from '@/lib/db/repo';
import { requireUserId, UnauthenticatedError } from '@/lib/auth';
import { aiRuntime } from '@/lib/ai/runtime';
import { AiClient } from '@/lib/ai/client';
import { BudgetExceededError } from '@/lib/ai/budget';
import { extractCvText, MAX_CV_BYTES } from '@/lib/resume/extract';

export const runtime = 'nodejs';

/**
 * Read an uploaded CV into a draft profile.
 *
 * Replaces the demand that a user hand-write 690 lines of JSON, which is the one
 * thing that made this application unusable by anyone who had not read its
 * schema. The pipeline is deliberately split in two:
 *
 *   1. Extraction — deterministic, free, no model. Just the words in the file.
 *   2. Drafting — a model call, budget-guarded like every other one.
 *
 * And it deliberately stops short of a third step. **Nothing is saved here.**
 * The response is a draft for the person to review field by field; saving is a
 * separate, explicit request from the review screen. That is what preserves the
 * rule the JSON upload existed to enforce — a profile is something the person
 * asserted, not something a model decided — while moving the typing off them.
 *
 * Authenticated on purpose. Drafting costs money, and an anonymous endpoint that
 * spends on a model is an open tap. New users therefore upload their CV at
 * signup, where it is only stored as text, and the drafting happens after
 * approval on their own account and their own budget.
 */
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const userId = await requireUserId();

    const form = await request.formData().catch(() => null);
    const file = form?.get('cv');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Attach a CV file as "cv".' }, { status: 400 });
    }
    if (file.size > MAX_CV_BYTES) {
      return NextResponse.json(
        { error: `That file is ${(file.size / 1024 / 1024).toFixed(1)}MB. The limit is 8MB.` },
        { status: 413 }
      );
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    const extracted = await extractCvText(file.name, bytes);

    // A failure to read is reported as a failure to read, not as an empty draft.
    // Sending a model 40 characters of garbage produces a confident, fictional
    // profile, which is the exact outcome this whole design exists to prevent.
    if (!extracted.text || extracted.errors.length) {
      return NextResponse.json(
        { error: extracted.errors[0] ?? 'No text could be read from that file.', errors: extracted.errors },
        { status: 422 }
      );
    }

    const [profile, provider] = await Promise.all([latestProfile(userId), getAiProvider(userId)]);
    const chosen = (provider === 'gemini' ? 'gemini' : 'claude') as 'gemini' | 'claude';
    if (!AiClient.isConfigured(chosen)) {
      return NextResponse.json(
        { error: `${chosen === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY'} is not set, so a CV cannot be read.` },
        { status: 400 }
      );
    }

    // aiRuntime needs a profile for its stable context. A first-time user has
    // none, which is the whole point of this endpoint, so an empty stand-in is
    // passed: draftProfileFromCv sets stableContext to '' and never reads it.
    const { client, services, guard } = await aiRuntime(userId, profile?.data ?? EMPTY_PROFILE, chosen);
    const before = client.stats.estimatedCostUsd;

    const draft = await services.draftProfileFromCv(extracted.text);

    // Spend is flushed before responding: a serverless function can be frozen
    // the instant it answers, and an unrecorded charge is a cap that stopped
    // applying.
    await guard.flush();

    return NextResponse.json({
      ok: true,
      draft,
      source: { kind: extracted.kind, characters: extracted.text.length, pages: extracted.pages },
      costUsd: client.stats.estimatedCostUsd - before,
      spentTodayUsd: guard.spentLast24h(),
      // Stated plainly so the review screen can say it rather than imply it.
      saved: false,
    });
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

/** Enough of a profile to satisfy the runtime's type; never read by drafting. */
const EMPTY_PROFILE = {
  version: 0,
  name: '',
  headline: '',
  email: '',
  phone: '',
  location: '',
  links: { linkedin: null, github: null },
  summary: '',
  totalYears: 0,
  experience: [],
  skills: [],
  projects: [],
  education: [],
  certifications: [],
  languages: [],
  employmentGaps: [],
  workAuthorisation: {
    euCitizen: false,
    euWorkPermit: false,
    needsSponsorship: true,
    currentCountry: '',
    notes: '',
  },
} as unknown as Parameters<typeof aiRuntime>[1];
