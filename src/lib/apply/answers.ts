/**
 * The answer bank: how the apply bot answers an application form's questions
 * without a person and without an API key.
 *
 * A form question is answered by the FIRST rule whose pattern matches its label.
 * Order is the whole design: "Do you have the legal right to work in Poland
 * (e.g. citizenship, permanent residency or a visa)?" mentions a visa, so the
 * right-to-work rule must be tried before the sponsorship rule, or the bot would
 * answer "Yes" to having the right to work. Every default here is a TRUE answer
 * for the candidate in `workAuthorisation`; a false one costs more than a skipped
 * application -- it is discovered at the visa check, after the offer.
 *
 * A required question no rule answers is never guessed. The job goes to the
 * manual queue and the label is recorded, so one answer added to the person's
 * `custom` map clears that question on every later form that asks it.
 */

export interface FormOption {
  label: string;
  value: string | number;
}

export interface FormQuestion {
  label: string;
  required: boolean;
  /** Field name the form posts, e.g. `question_68408119`. */
  name: string;
  kind: 'text' | 'textarea' | 'select' | 'multiselect' | 'file' | 'hidden';
  options: FormOption[];
}

export type Answer =
  | { kind: 'text'; value: string }
  | { kind: 'option'; option: FormOption }
  | { kind: 'options'; options: FormOption[] }
  | { kind: 'freeform' } // needs written prose: handed to the local model
  | { kind: 'skip' } // optional, and nothing true to say
  | { kind: 'unanswered'; reason: string };

/** What the bot knows about the candidate. Everything here is the person's own statement. */
export interface ApplicantFacts {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  linkedin: string;
  github: string;
  city: string;
  country: string;
  nationality: string;
  currentEmployer: string;
  currentTitle: string;
  totalYears: number;
  /** "One month" etc. Required: there is no true default for this. */
  noticePeriod: string;
  /** Whether the candidate consents to interview recording / AI note-takers. */
  consentToRecording: boolean;
  /** Whether the candidate is willing to work on site or hybrid after relocating. */
  willingOnsite: boolean;
  /** Exact form label (lowercased, trimmed) -> answer text or option label. */
  custom: Record<string, string>;
}

export interface JobContext {
  company: string;
  title: string;
  country: string | null;
  /** Pre-formatted salary quote in the job's own currency, or null. */
  salary: string | null;
}

type Rule = {
  test: RegExp;
  answer: (q: FormQuestion, f: ApplicantFacts, j: JobContext) => Answer;
};

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** The first option whose label matches, or null. */
export function pickOption(q: FormQuestion, ...patterns: RegExp[]): FormOption | null {
  for (const p of patterns) {
    const hit = q.options.find((o) => p.test(norm(o.label)));
    if (hit) return hit;
  }
  return null;
}

/** Text for a text box, an option for a choice; unanswered when no option fits. */
function either(q: FormQuestion, text: string, ...patterns: RegExp[]): Answer {
  if (q.kind === 'text' || q.kind === 'textarea') return { kind: 'text', value: text };
  const option = pickOption(q, ...patterns);
  return option ? { kind: 'option', option } : { kind: 'unanswered', reason: 'no option fits the true answer' };
}

const YES = /^yes\b/;
const NO = /^no\b/;
const DECLINE = /decline|prefer not|do not wish|don't wish|not to (say|disclose|answer)|rather not/;

/** Option for a years-of-experience range such as "3-5 years" or "5+". */
function yearsOption(q: FormQuestion, years: number): FormOption | null {
  for (const o of q.options) {
    const label = norm(o.label);
    const range = label.match(/(\d+)\s*(?:-|–|to)\s*(\d+)/);
    if (range && years >= Number(range[1]) && years <= Number(range[2])) return o;
    const plus = label.match(/(\d+)\s*\+|more than (\d+)|over (\d+)/);
    if (plus && years >= Number(plus[1] ?? plus[2] ?? plus[3])) return o;
  }
  return null;
}

/**
 * Ordered. Specific before general; denials (right to work) before the visa
 * rule that would otherwise catch the same sentence.
 */
export const RULES: Rule[] = [
  // Identity, read before anything fuzzy can claim the label.
  { test: /^first name|^given name|^preferred (first )?name/, answer: (_q, f) => ({ kind: 'text', value: f.firstName }) },
  { test: /^last name|^surname|^family name/, answer: (_q, f) => ({ kind: 'text', value: f.lastName }) },
  { test: /^full name|^name$/, answer: (_q, f) => ({ kind: 'text', value: `${f.firstName} ${f.lastName}` }) },
  { test: /^e-?mail/, answer: (_q, f) => ({ kind: 'text', value: f.email }) },
  { test: /^phone|mobile number|telephone/, answer: (_q, f) => ({ kind: 'text', value: f.phone }) },
  { test: /linkedin/, answer: (_q, f) => ({ kind: 'text', value: f.linkedin }) },
  { test: /github|portfolio|personal (website|site)|^website/, answer: (_q, f) => ({ kind: 'text', value: f.github }) },

  // Work authorisation. Right to work FIRST: its wording often mentions a visa.
  {
    test: /right to work|legal(ly)? (right|authori[sz]ed|entitled|permitted|able) to work|authori[sz]ed to work|eligible to work|work (permit|authori[sz]ation)|permission to work/,
    answer: (q) => either(q, 'No', NO),
  },
  {
    test: /sponsor|visa|blue card|work permit support/,
    answer: (q) => either(q, 'Yes', YES),
  },
  { test: /relocat/, answer: (q) => either(q, 'Yes', YES) },
  { test: /citizenship|nationality/, answer: (q, f) => either(q, f.nationality, new RegExp(norm(f.nationality)), /india/) },
  {
    test: /where (do|are) you (currently )?(live|living|based|located)|country of residence|current (country|location)|currently (live|reside|based)|where are you based/,
    answer: (q, f) => either(q, `${f.city}, ${f.country}`, new RegExp(`^${norm(f.country)}$`), new RegExp(norm(f.country))),
  },
  {
    test: /hybrid|in the office|from the office|on-?site|in person|office (\d|three|two|days)|commut/,
    answer: (q, f) => (f.willingOnsite ? either(q, 'Yes', YES) : { kind: 'unanswered', reason: 'on-site question and willingOnsite is false' }),
  },

  // History with this employer.
  {
    test: /previously (been )?(employed|worked)|worked (for|at|with) .* before|former employee|ever (been )?(employed|worked)|have you (ever )?applied/,
    answer: (q) => either(q, 'No', /never/, NO),
  },

  // Money and timing.
  {
    test: /salary|compensation|pay expectation|remuneration|expected (gross|annual|pay)/,
    answer: (q, _f, j) => (j.salary ? either(q, j.salary) : { kind: 'unanswered', reason: 'no salary quote for this country' }),
  },
  {
    test: /notice period|earliest (availability|start)|start date|when (can|could) you start|available to start|availability/,
    answer: (q, f) => either(q, f.noticePeriod),
  },
  { test: /years of (professional |relevant |work )?experience|how many years/, answer: (q, f) => {
    if (q.kind === 'text' || q.kind === 'textarea') return { kind: 'text', value: String(Math.floor(f.totalYears)) };
    const option = yearsOption(q, f.totalYears);
    return option ? { kind: 'option', option } : { kind: 'unanswered', reason: 'no experience band fits' };
  } },
  { test: /current (company|employer)|most recent (company|employer)/, answer: (q, f) => either(q, f.currentEmployer) },
  { test: /current (job )?(title|role|position)|most recent (title|role)/, answer: (q, f) => either(q, f.currentTitle) },

  // Language. English is held; other languages are not, and saying so is the honest answer.
  { test: /english/, answer: (q) => either(q, 'Professional working proficiency', /fluent|professional|proficient|advanced|c2|c1|native|yes/) },
  {
    test: /german|deutsch|dutch|french|polish|spanish|italian|portuguese|czech|swedish|danish|norwegian|finnish/,
    answer: (q) => either(q, 'No', NO, /none|no knowledge|not at all/),
  },

  // Consent and process.
  {
    test: /notetaker|note-taker|recording|record (the|your|this) interview|transcri/,
    answer: (q, f) =>
      f.consentToRecording
        ? either(q, 'Yes', /i consent|^yes/, /agree/)
        : either(q, 'No', /do not consent|don't consent|^no\b/),
  },
  {
    test: /privacy|data (protection|processing|retention)|gdpr|consent|acknowledge|i (have read|agree|confirm|understand)|terms (and|&) conditions|terms of use/,
    answer: (q) => either(q, 'Yes', /^yes|i agree|agree|i consent|consent|acknowledge|i have read|i confirm|confirm|accept/),
  },
  { test: /how did you (hear|find|learn)|where did you (hear|find|see)|^source$|referral source|application source/, answer: (q) => either(q, 'Company careers page', /careers|company website|website|job board|other/) },
  { test: /access(ibility)? (needs|requirements)|adjustment|accommodation/, answer: (q) => either(q, 'No', NO, /none|not required/) },

  // Equal-opportunity monitoring: always the "prefer not to say" option when one exists.
  {
    test: /gender|ethnic|race|racial|veteran|disabilit|sexual orientation|pronoun|religio|diversity|\bage\b|date of birth|transgender/,
    answer: (q) => {
      if (q.kind === 'text' || q.kind === 'textarea') return q.required ? { kind: 'unanswered', reason: 'demographic free text' } : { kind: 'skip' };
      const option = pickOption(q, DECLINE);
      return option ? { kind: 'option', option } : q.required ? { kind: 'unanswered', reason: 'no decline option' } : { kind: 'skip' };
    },
  },

  // Prose about this employer: written by the local model, guarded in code.
  { test: /why (do you want|are you interested|this (role|company|position))|motivat|what (excites|interests|attracts) you|cover letter|tell us (about yourself|why)|additional information/, answer: (q) => (q.kind === 'textarea' || q.kind === 'text' ? { kind: 'freeform' } : { kind: 'unanswered', reason: 'motivation as a choice' }) },
];

/** Answer one question: the person's own `custom` answer wins, then the rules. */
export function answerQuestion(q: FormQuestion, facts: ApplicantFacts, job: JobContext): Answer {
  if (q.kind === 'file' || q.kind === 'hidden') return { kind: 'skip' };
  const label = norm(q.label);

  const custom = facts.custom[label];
  if (custom !== undefined) {
    if (q.kind === 'text' || q.kind === 'textarea') return { kind: 'text', value: custom };
    const option = q.options.find((o) => norm(o.label) === norm(custom));
    if (option) return { kind: 'option', option };
  }

  for (const rule of RULES) {
    if (!rule.test.test(label)) continue;
    const answer = rule.answer(q, facts, job);
    if (answer.kind === 'unanswered' && !q.required) return { kind: 'skip' };
    if (answer.kind === 'option' && q.kind === 'multiselect') return { kind: 'options', options: [answer.option] };
    return answer;
  }
  return q.required ? { kind: 'unanswered', reason: 'no rule matches this question' } : { kind: 'skip' };
}

/**
 * Guard for model-written prose, the same principle as `resume/evidence.ts`:
 * invented specifics live in numbers, so any digit the facts did not contain is
 * refused, as is anything implying people management or longer than a form box
 * should hold.
 */
export function acceptProse(text: string, allowedText: string): string | null {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length < 80 || clean.split(' ').length > 160) return null;
  const allowed = new Set(allowedText.match(/\d+/g) ?? []);
  for (const n of clean.match(/\d+/g) ?? []) if (!allowed.has(n)) return null;
  if (/\b(led a team|managed a team|line manage|direct reports|team lead|head of)\b/i.test(clean)) return null;
  if (/\[|\]|lorem|as an ai/i.test(clean)) return null;
  return clean;
}
