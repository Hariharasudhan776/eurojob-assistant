import type { Page } from 'playwright-core';
import type { Answer, FormQuestion } from './answers.ts';

/**
 * Greenhouse, the platform behind most of the employer boards this app reads.
 *
 * Two halves, deliberately separate:
 *
 *  * the QUESTIONS come from Greenhouse's public Job Board API
 *    (`?questions=true`), which needs no key and returns every field's name,
 *    type, options and whether it is required -- so answering is decided in
 *    code before a browser is opened, and a job with an unanswerable question
 *    never costs a page load;
 *  * the SUBMISSION goes through the hosted form in a real browser, because the
 *    API's POST endpoint takes the employer's private key, which no applicant
 *    has.
 *
 * The embed URL is used rather than the board URL: many employers redirect the
 * board URL to their own careers site (often behind a bot challenge), while the
 * embed always renders Greenhouse's own form.
 */

interface GhField {
  name: string;
  type: string;
  values: { label: string; value: string | number }[];
}
interface GhQuestion {
  label: string;
  required: boolean;
  fields: GhField[];
}
/** Demographic questions use their own shape: answer_options, no fields. */
interface GhDemographic {
  id: number;
  label: string;
  required: boolean;
  answer_options?: { id: number; label: string }[];
}
interface GhJob {
  title: string;
  questions?: GhQuestion[];
  location_questions?: GhQuestion[];
  demographic_questions?: { questions?: GhDemographic[] } | null;
}

export const embedUrl = (board: string, id: string) =>
  `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(board)}&token=${encodeURIComponent(id)}`;

const KIND: Record<string, FormQuestion['kind']> = {
  input_text: 'text',
  textarea: 'textarea',
  input_file: 'file',
  input_hidden: 'hidden',
  multi_value_single_select: 'select',
  multi_value_multi_select: 'multiselect',
};

function toQuestion(q: GhQuestion): FormQuestion {
  // A question can carry several fields (resume: a file OR pasted text). The
  // first is the primary one the form shows.
  const field = q.fields[0];
  return {
    label: q.label.replace(/\s+/g, ' ').trim(),
    required: q.required,
    name: field?.name ?? '',
    kind: KIND[field?.type ?? ''] ?? 'text',
    options: (field?.values ?? []).map((v) => ({ label: v.label, value: v.value })),
  };
}

/** The form's questions, or null when the posting no longer exists. */
export async function fetchQuestions(board: string, id: string): Promise<{ title: string; questions: FormQuestion[] } | null> {
  const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}?questions=true`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Greenhouse API ${res.status} for ${board}/${id}`);
  const job = (await res.json()) as GhJob;
  const questions = (job.questions ?? []).filter((q) => q.fields?.length).map(toQuestion);
  // Demographic monitoring is voluntary almost everywhere and is never filled
  // here. A board that makes one REQUIRED still gets it listed -- with no field
  // name, so fillAndSubmit reports it as unfilled and the job goes to the
  // manual queue instead of anyone guessing an answer.
  for (const d of job.demographic_questions?.questions ?? []) {
    if (!d.required) continue;
    questions.push({
      label: d.label, required: true, name: '', kind: 'select',
      options: (d.answer_options ?? []).map((o) => ({ label: o.label, value: o.id })),
    });
  }
  return { title: job.title, questions };
}

export type FillOutcome =
  | { status: 'filled' } // dry run: everything answered, nothing sent
  | { status: 'submitted' }
  | { status: 'failed'; reason: string };

export interface FillInput {
  questions: { question: FormQuestion; answer: Answer }[];
  resumePath: string;
  coverLetterPath: string | null;
  phoneCountry: string;
  city: string;
  submit: boolean;
  screenshot: string;
}

const pause = (page: Page, ms: number) => page.waitForTimeout(ms);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Pick an option in Greenhouse's React combobox: open, type, click.
 *
 * Options are looked for only inside THIS field's listbox
 * (`react-select-<id>-listbox`): the page also carries ~240 hidden phone-country
 * options, and a page-wide search can land on one. Question answers must match
 * exactly -- their labels come from the API, so a near miss means a different
 * answer. `loose` is for search fields (city, phone country), where the first
 * suggestion starting with the typed text is the intended one.
 */
async function chooseCombo(page: Page, inputId: string, label: string, loose = false): Promise<boolean> {
  const input = page.locator(`input[id="${inputId}"]`);
  if (!(await input.count())) return false;
  await input.click();
  await input.fill('');
  await input.pressSequentially(label.slice(0, 30), { delay: 15 });
  const options = page.locator(`[id="react-select-${inputId}-listbox"] [role="option"]`);
  const wanted = loose
    ? new RegExp(`^\\s*${escapeRe(label.trim())}`, 'i')
    : new RegExp(`^\\s*${escapeRe(label.trim())}\\s*$`, 'i');
  const target = options.filter({ hasText: wanted }).first();
  try {
    await target.waitFor({ state: 'visible', timeout: 8000 });
    await target.click();
    return true;
  } catch {
    await page.keyboard.press('Escape');
    return false;
  }
}

/** Multi-select answers render as checkboxes on newer boards and as a combobox on older ones. */
async function chooseMany(page: Page, name: string, labels: string[]): Promise<boolean> {
  let ok = true;
  for (const label of labels) {
    const box = page.locator(`input[type="checkbox"][name^="${name}"]`);
    const byLabel = page.getByLabel(label, { exact: true });
    if ((await box.count()) && (await byLabel.count())) {
      await byLabel.first().check();
    } else {
      ok = (await chooseCombo(page, name, label)) && ok;
    }
  }
  return ok;
}

async function outcomeAfterSubmit(page: Page): Promise<FillOutcome> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const text = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
    if (/thank you for applying|application (has been )?(submitted|received)|we('|’)ve received your application/.test(text) || /confirmation/.test(page.url())) {
      return { status: 'submitted' };
    }
    if (/security code|verification code/.test(text)) return { status: 'failed', reason: 'security code requested by email' };
    if (await page.locator('iframe[src*="recaptcha"][src*="bframe"], iframe[src*="hcaptcha"]').count()) {
      const visible = await page.locator('iframe[src*="bframe"], iframe[src*="hcaptcha"]').first().isVisible().catch(() => false);
      if (visible) return { status: 'failed', reason: 'CAPTCHA challenge shown: finish this one by hand' };
    }
    await pause(page, 1000);
  }
  const errors = await page.locator('[aria-invalid="true"]').evaluateAll((els) =>
    els.map((e) => (e as HTMLElement).id).filter(Boolean).slice(0, 5)
  ).catch(() => [] as string[]);
  return { status: 'failed', reason: errors.length ? `form rejected fields: ${errors.join(', ')}` : 'no confirmation within 45s' };
}

/**
 * Fill the form and, only when `submit` is set, send it.
 *
 * In a dry run the resume is NOT attached: Greenhouse uploads a file the moment
 * it is chosen, so attaching would send the CV to the employer even though the
 * application never is. Everything else is typed, which transmits nothing.
 */
export async function fillAndSubmit(page: Page, url: string, input: FillInput): Promise<FillOutcome> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  if (!(await page.locator('form').count())) return { status: 'failed', reason: 'no application form on the page' };
  await page.locator('input#first_name').waitFor({ timeout: 20_000 });
  // The form is server-rendered and then hydrated by React, which resets any
  // value typed before it finishes: the first dry run lost First Name exactly
  // this way. Wait for the network to settle, then verify every box below.
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await pause(page, 1500);

  const misses: string[] = [];
  for (const { question, answer } of input.questions) {
    const id = question.name;
    if (!id) { if (question.required) misses.push(question.label); continue; }
    if (answer.kind === 'skip' || answer.kind === 'unanswered' || answer.kind === 'freeform') continue;
    if (answer.kind === 'text') {
      const field = page.locator(`[id="${id}"]`);
      if (!(await field.count())) { if (question.required) misses.push(question.label); continue; }
      await field.fill(answer.value);
    } else if (answer.kind === 'option') {
      if (!(await chooseCombo(page, id, answer.option.label))) misses.push(question.label);
    } else if (answer.kind === 'options') {
      if (!(await chooseMany(page, id, answer.options.map((o) => o.label)))) misses.push(question.label);
    }
    await pause(page, 120);
  }

  // Fields the page adds that the API does not list.
  if (await page.locator('input[id="country"]').count()) {
    if (!(await chooseCombo(page, 'country', input.phoneCountry, true))) misses.push('Phone country');
  }
  if (await page.locator('input[id="candidate-location"]').count()) {
    if (!(await chooseCombo(page, 'candidate-location', input.city, true))) misses.push('Location (City)');
  }

  // Verify pass: re-read every typed box and refill any the page has reset.
  for (const { question, answer } of input.questions) {
    if (answer.kind !== 'text' || !question.name) continue;
    const field = page.locator(`[id="${question.name}"]`);
    if (!(await field.count())) continue;
    if ((await field.inputValue().catch(() => '')) !== answer.value) {
      await field.fill(answer.value);
      if ((await field.inputValue().catch(() => '')) !== answer.value) misses.push(`${question.label} (would not keep its value)`);
    }
  }

  if (input.submit) {
    await page.locator('input[type="file"]#resume').setInputFiles(input.resumePath);
    if (input.coverLetterPath && (await page.locator('input[type="file"]#cover_letter').count())) {
      await page.locator('input[type="file"]#cover_letter').setInputFiles(input.coverLetterPath);
    }
    await pause(page, 3000); // let the upload finish before submitting
  }

  await page.screenshot({ path: input.screenshot, fullPage: true });
  if (misses.length) return { status: 'failed', reason: `could not fill: ${misses.join('; ')}` };
  if (!input.submit) return { status: 'filled' };

  await page.getByRole('button', { name: /submit application|submit/i }).first().click();
  const outcome = await outcomeAfterSubmit(page);
  await page.screenshot({ path: input.screenshot.replace(/\.png$/, '.after.png'), fullPage: true });
  return outcome;
}
