/**
 * Tailored resume for one job from the command line -- the same pipeline as the
 * job page's "Tailored resume" button (tailor, verify, recruiter-scan audit).
 *
 *   npm run tailor -- 205859              DOCX into data/tailored/205859/
 *   npm run tailor -- 205859 --gemini     force the free provider
 *   npm run tailor -- 205859 --ollama     local model (OLLAMA_MODEL)
 *   npm run tailor -- 205859 --cover      also write a verified cover letter
 *   npm run tailor -- 205859 --from=x.json  hand-written {resume, letter?}, same checks, no AI call
 *   npm run tailor -- 4484444032 --copied=jobs.json --from=x.json  posting from a job:add import file, no database writes
 *
 * The file name carries no version or company, so what the employer sees is
 * just the candidate's name.
 */
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { getAiProvider, getJob, latestProfile, saveDocument } from '../src/lib/db/repo.ts';
import { scoreJob } from '../src/lib/match/score.ts';
import { targetCountriesFor } from '../src/lib/match/rescore.ts';
import { aiRuntime } from '../src/lib/ai/runtime.ts';
import { checkCoverLetter, checkTailoredResume } from '../src/lib/ai/services.ts';
import { CoverLetter, TailoredResume } from '../src/lib/ai/schemas.ts';
import type { Violation } from '../src/lib/ai/verify.ts';
import { providerFrom } from '../src/lib/ai/client.ts';
import { buildMirrorPlan } from '../src/lib/resume/mirror.ts';
import { auditResume } from '../src/lib/resume/audit.ts';
import { renderCoverLetter, renderResume, renderResumeText } from '../src/lib/docs/render.ts';
import { jobRowToNormalised } from '../src/lib/jobs/from-row.ts';
import { getPool } from '../src/lib/db/pool.ts';
import { normalise } from '../src/lib/jobs/sources/ats.ts';
import { parseLocation } from '../src/lib/jobs/parse.ts';

const USER_ID = 1;
const jobId = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)));
if (!Number.isInteger(jobId) || jobId <= 0) throw new Error('usage: npm run tailor -- <jobId>');

// shortcut: --copied tailors straight from a job:add import file and saves nothing to `documents`
// (added while the Neon database was full); drop it once job:add can store postings again.
const copiedArg = process.argv.find((x) => x.startsWith('--copied='))?.slice(9);
const copied = copiedArg
  ? (JSON.parse(readFileSync(copiedArg, 'utf8')) as { id: string; url: string; title: string; company: string; location: string; description: string }[])
      .find((j) => j.id === String(jobId))
  : undefined;
if (copiedArg && !copied) throw new Error(`job ${jobId} not in ${copiedArg}`);

const [job, profile, preferredCountries, stored] = await Promise.all([
  copied ? null : getJob(USER_ID, jobId), latestProfile(USER_ID), targetCountriesFor(USER_ID), getAiProvider(USER_ID),
]);
if (!job && !copied) throw new Error(`job ${jobId} not found`);
if (!profile) throw new Error('no profile');

const normalised = copied
  ? normalise({ slug: `copied:${copied.id}`, url: copied.url, title: copied.title, company: copied.company, ...parseLocation(copied.location), locationText: copied.location, description: copied.description, postedAt: new Date(), raw: copied })
  : jobRowToNormalised(job!);
const jobTitle = copied?.title ?? job!.title;
const jobCompany = copied?.company ?? job!.company;
const match = scoreJob(profile.data, normalised, { preferredCountries });
const mirror = buildMirrorPlan(match.requirements.required, match.requirements.preferred, profile.data);
const dir = `data/tailored/${jobId}`;
const base = `${dir}/${profile.data.name.replace(/\s+/g, '_')}`;
mkdirSync(dir, { recursive: true });
const fromArg = process.argv.find((x) => x.startsWith('--from='))?.slice(7);

// Either written by the configured AI provider, or by hand (--from) -- the same
// checks, audit and renderer apply to both.
let resume: TailoredResume, resumeViolations: Violation[], letterOut: CoverLetter | undefined, letterViolations: Violation[] = [];
let model = 'hand-written', costUsd = 0, flush = async () => {};
if (fromArg) {
  const raw = JSON.parse(readFileSync(fromArg, 'utf8'));
  resume = TailoredResume.parse(raw.resume);
  resumeViolations = checkTailoredResume(profile.data, resume, match, mirror).violations;
  if (raw.letter) {
    letterOut = CoverLetter.parse(raw.letter);
    letterViolations = checkCoverLetter(profile.data, letterOut, match).violations;
  }
} else {
  const provider = providerFrom(process.argv.includes('--gemini') ? 'gemini' : process.argv.includes('--ollama') ? 'ollama' : stored);
  const { client, services, guard } = await aiRuntime(USER_ID, profile.data, provider);
  const r = await services.tailorResume(normalised, match);
  resume = r.output; resumeViolations = r.violations;
  if (process.argv.includes('--cover')) {
    const cl = await services.writeCoverLetter(normalised, match, 'professional');
    letterOut = cl.output; letterViolations = cl.violations;
  }
  model = client.model; flush = () => guard.flush();
  costUsd = Number(client.stats.estimatedCostUsd.toFixed(3));
}

// A flagged claim is only acceptable if it never reached the page.
const printedIn = (text: string, violations: Violation[]) =>
  violations.map((v) => v.detail.match(/"([^"]+)"/)?.[1]).filter((t): t is string => !!t && text.toLowerCase().includes(t.toLowerCase()));
const resumeText = renderResumeText(profile.data, resume);
const printed = printedIn(resumeText, resumeViolations);
if (printed.length) throw new Error(`unevidenced claims printed, not saving: ${printed.join(', ')}`);
const audit = auditResume(profile.data, resume, mirror, normalised, resumeText);

// The DOCX on disk is the deliverable; the DB copy is a record. A full database
// (Neon free tier, 1 GB) must not stop an application, so a failed save only warns.
const keep = (p: Promise<unknown>) => p.catch((e) => console.warn(`document not saved to DB: ${e instanceof Error ? e.message : e}`));
if (!copied) await keep(saveDocument({
  userId: USER_ID, jobId, profileId: profile.id, kind: 'resume', tone: null,
  content: resume, provenance: { provenance: resume.provenance, violations: resumeViolations, audit }, model,
}));
const file = `${base}_Resume.docx`;
writeFileSync(file, await renderResume(profile.data, resume, jobTitle, jobCompany));

let letter: string | undefined;
if (letterOut) {
  const inLetter = printedIn([letterOut.subjectLine, ...letterOut.paragraphs].join(' '), letterViolations);
  if (inLetter.length) throw new Error(`cover letter refused, unevidenced claims printed: ${inLetter.join(', ')}`);
  if (!copied) await keep(saveDocument({
    userId: USER_ID, jobId, profileId: profile.id, kind: 'cover_letter', tone: 'professional',
    content: letterOut, provenance: { claimsMade: letterOut.claimsMade, violations: letterViolations }, model,
  }));
  letter = `${base}_Cover_Letter.docx`;
  writeFileSync(letter, await renderCoverLetter(profile.data, letterOut, jobTitle, jobCompany));
}
await flush();

console.log(JSON.stringify({
  file, letter, model, costUsd, audit: audit.score, verdict: audit.verdict, missed: audit.missedOpportunities,
  failed: audit.checks.filter((c) => !c.pass).map((c) => c.label),
  violations: [...resumeViolations, ...letterViolations].map((v) => `${v.severity}: ${v.detail}`),
}));
await getPool().end();
