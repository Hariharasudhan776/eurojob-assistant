/**
 * The apply bot: sends applications to top matches with nobody at the keyboard.
 *
 *   npm run apply                      dry run: answers and fills, sends nothing
 *   npm run apply -- --submit          real: attaches the CV and submits
 *   npm run apply -- --job=24910       one job only (dry run unless --submit)
 *   npm run apply -- --limit=5         at most 5 applications this run
 *   npm run apply -- --headless        no visible browser window
 *
 * No API key anywhere. Questions come from Greenhouse's public board API, answers
 * from `data/apply-answers.json` (the person's own statements) and the ordered
 * rules in `src/lib/apply/answers.ts`; the only prose -- "why do you want to work
 * here" -- is written by a local Ollama model and refused in code if it invents
 * a number. The browser is the Edge already installed on Windows.
 *
 * What it will not do: guess. A required question no rule answers sends the job
 * to the manual queue and records the label in `data/apply/unanswered.json`;
 * answering it once in the `custom` map clears it on every later form. A visible
 * CAPTCHA or an emailed security code also goes to the manual queue -- nothing
 * here solves or evades either.
 *
 * Pacing: a daily cap, at most `maxPerCompany` applications per employer per 30
 * days, and a random pause between submissions. Mass-applying to one company in
 * a morning reads as spam to its recruiters and is the fastest way to be ignored.
 */
import 'dotenv/config';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { getPool } from '../src/lib/db/pool.ts';
import { latestProfile, reportJobGone, setStage } from '../src/lib/db/repo.ts';
import { extractSalary } from '../src/lib/jobs/compensation.ts';
import { formatQuote, suggestQuote } from '../src/lib/jobs/quote.ts';
import { acceptProse, answerQuestion, type ApplicantFacts, type Answer, type FormQuestion, type JobContext } from '../src/lib/apply/answers.ts';
import { embedUrl, fetchQuestions, fillAndSubmit } from '../src/lib/apply/greenhouse.ts';
import type { CandidateProfile } from '../src/lib/resume/profile.ts';

const USER_ID = 1;
const DIR = 'data/apply';
const LOG = `${DIR}/log.jsonl`;
const UNANSWERED = `${DIR}/unanswered.json`;
const ANSWERS = process.argv.find((x) => x.startsWith('--answers='))?.slice(10) ?? 'data/apply-answers.json';

interface Settings {
  firstName: string;
  lastName: string;
  nationality: string;
  noticePeriod: string;
  consentToRecording: boolean;
  willingOnsite: boolean;
  resumeFile: string;
  minScore: number;
  dailyCap: number;
  maxPerCompany: number;
  countries: string[];
  custom: Record<string, string>;
}

interface LogEntry {
  at: string;
  jobId: number;
  company: string;
  title: string;
  status: 'submitted' | 'filled' | 'needs-answer' | 'failed' | 'gone';
  reason?: string;
  dryRun: boolean;
}

const args = new Map(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? 'true'] as const;
}));
const SUBMIT = args.has('submit');

function loadSettings(): Settings {
  if (!existsSync(ANSWERS)) {
    writeFileSync(ANSWERS, readFileSync('data/apply-answers.example.json', 'utf8'));
    console.error(`Created ${ANSWERS}. Fill in every "TODO" in it, then run again.`);
    process.exit(1);
  }
  const text = readFileSync(ANSWERS, 'utf8');
  if (/TODO/.test(text)) {
    console.error(`${ANSWERS} still has TODO values. Fill them in first: the bot never invents an answer.`);
    process.exit(1);
  }
  const s = JSON.parse(text) as Settings;
  s.custom = Object.fromEntries(Object.entries(s.custom ?? {}).map(([k, v]) => [k.toLowerCase().replace(/\s+/g, ' ').trim(), v]));
  return s;
}

function readLog(): LogEntry[] {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as LogEntry);
}

function log(entry: Omit<LogEntry, 'at' | 'dryRun'>) {
  const full: LogEntry = { at: new Date().toISOString(), dryRun: !SUBMIT, ...entry };
  appendFileSync(LOG, JSON.stringify(full) + '\n');
  const mark = { submitted: 'SENT  ', filled: 'FILLED', 'needs-answer': 'ASK   ', failed: 'MANUAL', gone: 'GONE  ' }[entry.status];
  console.log(`  ${mark} #${entry.jobId} ${entry.company} — ${entry.title}${entry.reason ? `  (${entry.reason})` : ''}`);
}

/** Collect unanswered labels across runs, with the options offered, so one answer fixes them all. */
function recordUnanswered(jobId: number, items: { question: FormQuestion; reason: string }[]) {
  const store = existsSync(UNANSWERED) ? JSON.parse(readFileSync(UNANSWERED, 'utf8')) : {};
  for (const { question, reason } of items) {
    const key = question.label.toLowerCase().replace(/\s+/g, ' ').trim();
    const row = store[key] ?? { label: question.label, reason, options: question.options.map((o) => o.label).slice(0, 40), jobs: [] };
    if (!row.jobs.includes(jobId)) row.jobs.push(jobId);
    store[key] = row;
  }
  writeFileSync(UNANSWERED, JSON.stringify(store, null, 2));
}

/** "Why us?" prose from the local model, or null. Refused if it invents a number. */
async function writeProse(question: FormQuestion, job: JobContext, profile: CandidateProfile): Promise<string | null> {
  const base = (process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const model = process.env.APPLY_OLLAMA_MODEL ?? process.env.OLLAMA_MODEL ?? 'qwen2.5-coder:7b';
  const facts = [profile.summary, ...profile.experience.slice(0, 2).flatMap((e) => e.bullets.slice(0, 4))].join('\n');
  const prompt = `Write the candidate's answer to an application form question, in first person, 70-120 words, plain text, no greeting, no placeholders.
Use ONLY these facts about the candidate; do not add numbers, employers, tools or achievements that are not in them:
${facts}

Job: ${job.title} at ${job.company}.
Question: ${question.label}
Answer:`;
  try {
    const res = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0.3, num_ctx: 4096 } }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { response?: string };
    return acceptProse(body.response ?? '', facts + ' ' + job.title + ' ' + job.company);
  } catch {
    return null; // Ollama not running: the question goes to the manual queue instead
  }
}

/** A plain cover letter built from the profile alone, for forms that require one. */
function coverLetter(profile: CandidateProfile, s: Settings, job: JobContext, jobId: number): string {
  const path = resolve(`${DIR}/cover-${jobId}.txt`);
  const text = [
    `Dear ${job.company} hiring team,`,
    '',
    `I am applying for the ${job.title} position. ${profile.summary}`,
    '',
    `I am based in ${profile.location} and require visa sponsorship to relocate; my notice period is ${s.noticePeriod.toLowerCase()}. My CV is attached, and I would welcome the chance to discuss the role.`,
    '',
    'Kind regards,',
    `${s.firstName} ${s.lastName}`,
    `${profile.email} | ${profile.phone}`,
  ].join('\r\n');
  writeFileSync(path, text, 'utf8');
  return path;
}

async function candidates(s: Settings) {
  const { rows } = await getPool().query(
    `SELECT j.id, j.title, j.company, j.country, j.description, j.source_job_id,
            j.salary_min, j.salary_max, j.salary_currency, m.overall
       FROM jobs j
       JOIN matches m ON m.job_id = j.id
                     AND m.profile_id = (SELECT id FROM profiles WHERE user_id = $1 ORDER BY version DESC LIMIT 1)
       LEFT JOIN applications a ON a.job_id = j.id AND a.user_id = $1
      WHERE j.source_slug = 'ats'
        AND split_part(j.source_job_id, ':', 1) = 'greenhouse'
        AND j.duplicate_of IS NULL AND j.closed_at IS NULL
        AND j.visa_sponsorship <> 'no'
        AND j.country = ANY($2::text[])
        AND m.overall >= $3
        AND m.recommendation <> 'low'
        AND (a.stage IS NULL OR a.stage IN ('new', 'shortlisted', 'resume_ready'))
        AND ($4::bigint IS NULL OR j.id = $4)
      ORDER BY m.overall DESC, j.posted_at DESC NULLS LAST
      LIMIT 300`,
    [USER_ID, s.countries, s.minScore, args.has('job') ? Number(args.get('job')) : null]
  );
  return rows;
}

async function main() {
  mkdirSync(`${DIR}/shots`, { recursive: true });
  const s = loadSettings();
  const resumePath = resolve(s.resumeFile);
  if (!existsSync(resumePath)) throw new Error(`resume not found: ${resumePath}`);
  const profile = (await latestProfile(USER_ID))?.data;
  if (!profile) throw new Error('no profile for user 1');

  const facts: ApplicantFacts = {
    firstName: s.firstName,
    lastName: s.lastName,
    email: profile.email,
    phone: profile.phone,
    linkedin: profile.links.linkedin?.startsWith('http') ? profile.links.linkedin : `https://${profile.links.linkedin}`,
    github: profile.links.github?.startsWith('http') ? profile.links.github : `https://${profile.links.github}`,
    city: profile.location.split(',')[0]!.trim(),
    country: profile.location.split(',').pop()!.trim(),
    nationality: s.nationality,
    currentEmployer: profile.experience[0]!.company,
    currentTitle: profile.experience[0]!.title,
    totalYears: profile.totalYears,
    noticePeriod: s.noticePeriod,
    consentToRecording: s.consentToRecording,
    willingOnsite: s.willingOnsite,
    custom: s.custom,
  };

  const history = readLog();
  const today = new Date().toISOString().slice(0, 10);
  const sentToday = history.filter((e) => e.status === 'submitted' && e.at.startsWith(today)).length;
  const cap = Math.min(Number(args.get('limit') ?? s.dailyCap), s.dailyCap - (SUBMIT ? sentToday : 0));
  const monthAgo = Date.now() - 30 * 86_400_000;
  const perCompany = new Map<string, number>();
  for (const e of history) {
    if (e.status === 'submitted' && Date.parse(e.at) > monthAgo) perCompany.set(e.company, (perCompany.get(e.company) ?? 0) + 1);
  }
  const done = new Set(history.filter((e) => e.status === 'submitted' || e.status === 'gone').map((e) => e.jobId));

  console.log(`${SUBMIT ? 'SUBMITTING' : 'DRY RUN (nothing is sent)'} — cap ${cap} this run, ${sentToday} already sent today`);
  if (cap <= 0) { console.log('Daily cap reached.'); return; }

  const jobs = await candidates(s);
  console.log(`${jobs.length} Greenhouse jobs qualify (score >= ${s.minScore}, sponsorship not refused, ${s.countries.length} countries)`);

  const browser = await chromium.launch({ channel: 'msedge', headless: args.has('headless') });
  const page = await (await browser.newContext({ locale: 'en-GB', viewport: { width: 1280, height: 900 } })).newPage();
  let processed = 0;

  try {
    for (const job of jobs) {
      if (processed >= cap) break;
      if (done.has(job.id)) continue;
      if ((perCompany.get(job.company) ?? 0) >= s.maxPerCompany) continue;
      const [, board = '', ghId = ''] = String(job.source_job_id).split(':');

      const form = await fetchQuestions(board, ghId).catch((e: Error) => { log({ jobId: job.id, company: job.company, title: job.title, status: 'failed', reason: e.message }); return undefined; });
      if (form === undefined) continue;
      if (form === null) {
        await reportJobGone(job.id);
        log({ jobId: job.id, company: job.company, title: job.title, status: 'gone', reason: 'posting removed from Greenhouse' });
        continue;
      }

      const quote = suggestQuote({
        country: job.country,
        description: job.description ?? '',
        structured: { min: job.salary_min, max: job.salary_max, currency: job.salary_currency },
        extracted: extractSalary(job.description ?? ''),
        candidateYears: profile.totalYears,
      });
      const ctx: JobContext = { company: job.company, title: job.title, country: job.country, salary: quote ? formatQuote(quote) : null };

      const planned: { question: FormQuestion; answer: Answer }[] = [];
      const open: { question: FormQuestion; reason: string }[] = [];
      let coverPath: string | null = null;
      for (const question of form.questions) {
        let answer = answerQuestion(question, facts, ctx);
        if (question.kind === 'file' && /cover letter/i.test(question.label) && question.required) {
          coverPath = coverLetter(profile, s, ctx, job.id);
        }
        if (answer.kind === 'freeform') {
          const prose = await writeProse(question, ctx, profile);
          answer = prose ? { kind: 'text', value: prose } : question.required ? { kind: 'unanswered', reason: 'needs prose and the local model gave none usable' } : { kind: 'skip' };
        }
        if (answer.kind === 'unanswered') open.push({ question, reason: answer.reason });
        planned.push({ question, answer });
      }
      if (open.length) {
        recordUnanswered(job.id, open);
        log({ jobId: job.id, company: job.company, title: job.title, status: 'needs-answer', reason: open.map((o) => o.question.label.slice(0, 60)).join(' | ') });
        continue;
      }

      const outcome = await fillAndSubmit(page, embedUrl(board, ghId), {
        questions: planned,
        resumePath,
        coverLetterPath: coverPath,
        phoneCountry: facts.country,
        city: facts.city,
        submit: SUBMIT,
        screenshot: resolve(`${DIR}/shots/${job.id}.png`),
      }).catch((e: Error) => ({ status: 'failed' as const, reason: e.message.split('\n')[0] }));

      processed++;
      if (outcome.status === 'submitted') {
        await setStage(USER_ID, job.id, 'applied', `Auto-applied by the apply bot (${job.overall}% match)`);
        perCompany.set(job.company, (perCompany.get(job.company) ?? 0) + 1);
        log({ jobId: job.id, company: job.company, title: job.title, status: 'submitted' });
        // A person takes minutes per form; a burst of seconds-apart submissions does not look like one.
        await page.waitForTimeout(60_000 + Math.random() * 120_000);
      } else if (outcome.status === 'filled') {
        log({ jobId: job.id, company: job.company, title: job.title, status: 'filled' });
      } else {
        log({ jobId: job.id, company: job.company, title: job.title, status: 'failed', reason: outcome.reason });
      }
    }
  } finally {
    await browser.close();
    await getPool().end();
  }
  console.log(`\nLog: ${LOG}   Screenshots: ${DIR}/shots/   Questions to answer once: ${UNANSWERED}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
