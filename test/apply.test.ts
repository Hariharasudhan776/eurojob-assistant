import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptProse, answerQuestion, type ApplicantFacts, type FormQuestion } from '../src/lib/apply/answers.ts';

const facts: ApplicantFacts = {
  firstName: 'Alex', lastName: 'K', email: 'a@example.com', phone: '+1 555 0100',
  linkedin: 'https://linkedin.com/in/x', github: 'https://github.com/x',
  city: 'Nairobi', country: 'Kenya', nationality: 'Kenyan',
  currentEmployer: 'Northwind', currentTitle: 'Software Developer', totalYears: 5.6,
  noticePeriod: 'One month', consentToRecording: false, willingOnsite: true, publicOfficial: false, custom: {},
};
const job = { company: 'Acme', title: 'Backend Developer', country: 'PL', salary: 'PLN 180,000 – 220,000' };
const yesNo = [{ label: 'Yes', value: 1 }, { label: 'No', value: 0 }];
const q = (label: string, extra: Partial<FormQuestion> = {}): FormQuestion =>
  ({ label, required: true, name: 'question_1', kind: 'select', options: yesNo, ...extra });
const picked = (a: ReturnType<typeof answerQuestion>) =>
  a.kind === 'option' ? a.option.label : a.kind === 'text' ? a.value : a.kind;

test('right to work is answered No even when the sentence mentions a visa', () => {
  // Real HelloFresh wording. The sponsorship rule also matches "visa"; order decides.
  const a = answerQuestion(q('Do you have the legal right to work in Poland (e.g citizenship, permanent residency or a visa)?'), facts, job);
  assert.equal(picked(a), 'No');
});

test('sponsorship is answered Yes', () => {
  assert.equal(picked(answerQuestion(q('Will you now or in the future require visa sponsorship?'), facts, job)), 'Yes');
});

test('country of residence picks the exact country from a long list', () => {
  const options = ['Afghanistan', 'Kenya', 'Romania'].map((label, i) => ({ label, value: i }));
  assert.equal(picked(answerQuestion(q('Where do you currently live?', { options }), facts, job)), 'Kenya');
});

test('salary uses the quote in the job currency', () => {
  assert.equal(picked(answerQuestion(q('What are your salary expectations?', { kind: 'text', options: [] }), facts, job)), 'PLN 180,000 – 220,000');
});

test('recording consent follows the stated preference', () => {
  const options = [
    { label: 'I consent to the recording and AI transcription of my interview.', value: 1 },
    { label: 'I do not consent. (We will not use the notetaker for your interview.)', value: 2 },
  ];
  const a = answerQuestion(q('Interview Recording and AI Notetaker — Notice', { options }), facts, job);
  assert.match(picked(a), /do not consent/);
});

test('a criminal-record question is not mistaken for recording consent', () => {
  const a = answerQuestion(q('Do you have a criminal record?'), facts, job);
  assert.equal(a.kind, 'unanswered');
});

test('demographic questions take the decline option, never a guess', () => {
  const options = ['Male', 'Female', 'I prefer not to say'].map((label, i) => ({ label, value: i }));
  assert.equal(picked(answerQuestion(q('Gender', { options }), facts, job)), 'I prefer not to say');
});

test('an unknown required question is left for the person, an optional one is skipped', () => {
  assert.equal(answerQuestion(q('Which of our values resonates most?'), facts, job).kind, 'unanswered');
  assert.equal(answerQuestion(q('Which of our values resonates most?', { required: false }), facts, job).kind, 'skip');
});

test('the person\'s own custom answer beats every rule', () => {
  const custom = { 'which of our values resonates most?': 'Yes' };
  assert.equal(picked(answerQuestion(q('Which of our values resonates most?'), { ...facts, custom }, job)), 'Yes');
});

test('years of experience picks the band that contains the total', () => {
  const options = ['0-2 years', '3-5 years', '5+ years'].map((label, i) => ({ label, value: i }));
  assert.equal(picked(answerQuestion(q('How many years of experience do you have?', { options }), facts, job)), '5+ years');
});

test('other languages are answered honestly', () => {
  assert.equal(picked(answerQuestion(q('Do you speak German?'), facts, job)), 'No');
});

test('model prose with an invented number is refused', () => {
  const facts = 'Five years building Oracle and PostgreSQL systems for 600+ users.';
  const ok = 'I build reliable database-backed applications and enjoy turning messy operational data into systems people trust. My work on Oracle and PostgreSQL for 600+ users maps directly onto this role.';
  assert.ok(acceptProse(ok, facts));
  assert.equal(acceptProse(ok.replace('600+', '2000+'), facts), null);
});

// --- labels collected by the first live dry run (data/apply/unanswered.json) ---

const opts = (...labels: string[]) => labels.map((label, i) => ({ label, value: i }));
const text = (label: string) => q(label, { kind: 'text', options: [] });

test('current-or-previous employer and title are answered', () => {
  assert.equal(picked(answerQuestion(text('Who is your current or previous employer?'), facts, job)), 'Northwind');
  assert.equal(picked(answerQuestion(text('What is your current or previous job title?'), facts, job)), 'Software Developer');
  assert.equal(picked(answerQuestion(text('Current or Most Recent Job Title'), facts, job)), 'Software Developer');
});

test('export-control screening is answered No, before the citizenship rule can claim it', () => {
  for (const label of [
    'Are you located in one of the following countries or regions: Belarus, Cuba, Iran, North Korea (DPRK), Syria, or Russia',
    'Is your most recent country of citizenship one of the following countries: Cuba, Iran, North Korea (DPRK), or Syria?',
    'Is your most recent legal permanent residency in one of the following countries: Cuba, Iran, North Korea (DPRK), or Syria?',
  ]) assert.equal(picked(answerQuestion(q(label), facts, job)), 'No', label);
});

test('EU citizenship, WhatsApp opt-in and contact method', () => {
  assert.equal(picked(answerQuestion(q('Are you an EU citizen (a citizen of European Union Member State)?'), facts, job)), 'No');
  assert.equal(picked(answerQuestion(q('Do you opt-in to receive WhatsApp messages from Stripe Recruiting?'), facts, job)), 'No');
  const how = q('How should we communicate with you?', { options: opts('Email', 'Phone Call', 'Text Message', 'WhatsApp') });
  assert.equal(picked(answerQuestion(how, facts, job)), 'Email');
});

test('UK and US residence questions get "not applicable" answers', () => {
  const uk = q('Which country in the United Kingdom do you reside in?', { options: opts('England', 'Scotland', 'Wales', 'Northern Ireland', 'Other') });
  assert.equal(picked(answerQuestion(uk, facts, job)), 'Other');
  assert.equal(picked(answerQuestion(text('If located in the US, in what city and state do you reside?'), facts, job)), 'Not applicable');
});

test('prior employment with an employer-specific option', () => {
  const affirm = q('Have you previously been employed at Affirm for any length of time?', {
    options: opts('I have not previously been employed at Affirm', 'I have been employed at Affirm as a full-time employee'),
  });
  assert.equal(picked(answerQuestion(affirm, facts, job)), 'I have not previously been employed at Affirm');
  assert.equal(picked(answerQuestion(q('Have you been employed by Cockroach Labs in the past?'), facts, job)), 'No');
});

test('anticipated work country, remote preference and source', () => {
  const where = q('Please select the country or countries you anticipate working in for the role in which you are applying.', {
    kind: 'multiselect', options: opts('Australia', 'Germany', 'India', 'Poland'),
  });
  const a = answerQuestion(where, facts, { ...job, countryName: 'Poland' });
  assert.ok(a.kind === 'options' && a.options[0]!.label === 'Poland');
  const remote = q('If this role offers the option to work from a remote location, do you plan to work remotely?', {
    options: opts('Yes, I intend to work remotely.', 'No, I intend to work from an office location.'),
  });
  assert.match(picked(answerQuestion(remote, facts, job)), /office/);
  const learn = q('How did you first learn about Affirm as an employer?', { options: opts('Affirm blog', 'Affirm’s Career Site', 'Glassdoor') });
  assert.equal(picked(answerQuestion(learn, facts, job)), 'Affirm’s Career Site');
});

test('salary bands pick the band holding the middle of the quote', () => {
  const bands = q('What are your salary expectations?', {
    options: opts('less than 40 000 EUR', '40 000 EUR - 45 000 EUR', '55 000 EUR - 60 000 EUR', '60 000 EUR - 70 000 EUR', 'more than 90 000 EUR'),
  });
  const a = answerQuestion(bands, facts, { ...job, salary: 'EUR 55,000 – 68,000', salaryRange: { min: 55_000, max: 68_000 } });
  assert.equal(picked(a), '60 000 EUR - 70 000 EUR');
});

test('a skill question is answered from the profile, honestly', () => {
  const withCheck = { ...facts, skillAnswer: (label: string) => (/graphql/i.test(label) ? false : /oracle/i.test(label) ? true : null) };
  assert.equal(picked(answerQuestion(q('Do you have deep, hands-on GraphQL expertise in Schema Design?'), withCheck, job)), 'No');
  assert.equal(picked(answerQuestion(q('Do you have experience with Oracle?'), withCheck, job)), 'Yes');
  assert.equal(answerQuestion(q('Do you have experience with our culture?'), withCheck, job).kind, 'unanswered');
});

test('decision influence and data-transfer acknowledgement', () => {
  const why = q('What was the largest influence on your decision to apply?', { options: opts('Benefits & Perks', 'The product', 'The role') });
  assert.equal(picked(answerQuestion(why, facts, job)), 'The role');
  assert.equal(picked(answerQuestion(q('Point of Data Transfer', { options: opts('Acknowledge/Confirm') }), facts, job)), 'Acknowledge/Confirm');
});

test('REGRESSION: sponsorship "for a work permit" is Yes, not caught by right to work', () => {
  // Stripe's wording. The right-to-work rule knows "work permit" and answered
  // No in a dry run -- the answer that would have misstated the visa need.
  const label = 'Will you require Stripe to sponsor you for a work permit now or in the future for the location(s) you selected in your previous response?';
  assert.equal(picked(answerQuestion(q(label), facts, job)), 'Yes');
  assert.equal(picked(answerQuestion(q('Are you authorized to work in the location(s) you selected in your previous response?'), facts, job)), 'No');
  assert.equal(picked(answerQuestion(q('Will you now or in the future require immigration sponsorship for employment visa status?'), facts, job)), 'Yes');
});

test('French field labels are recognised', () => {
  assert.equal(picked(answerQuestion(text('Prénom'), facts, job)), 'Alex');
  assert.equal(picked(answerQuestion(text('Nom'), facts, job)), 'K');
  assert.equal(picked(answerQuestion(text('Adresse e-mail'), facts, job)), 'a@example.com');
  assert.equal(picked(answerQuestion(text('Téléphone'), facts, job)), '+1 555 0100');
});

test('REGRESSION: residence never matches inside another country name', () => {
  // Stripe's list has no Oman; /oman/ matched "Romania".
  const omanFacts = { ...facts, country: 'Oman' };
  const stripe = q('Please select the country where you currently reside.', { options: opts('Poland', 'Romania', 'Spain', 'Other') });
  assert.equal(picked(answerQuestion(stripe, omanFacts, job)), 'Other');
  const listed = q('Please select the country where you currently reside.', { options: opts('Romania', 'Oman') });
  assert.equal(picked(answerQuestion(listed, omanFacts, job)), 'Oman');
});

test('REGRESSION: "careers" inside a campus option is not the careers site', () => {
  const mongo = q('How did you learn about this job?', {
    required: false, options: opts('College Careers Page / Event', 'LinkedIn', 'MongoDB Careers Site', 'Other'),
  });
  assert.equal(picked(answerQuestion(mongo, facts, job)), 'MongoDB Careers Site');
  const noFit = q('How did you hear about us?', { options: opts('College Careers Page / Event', 'Podcast') });
  assert.equal(answerQuestion(noFit, facts, job).kind, 'unanswered');
});

test('REGRESSION: "in what countries can you work" names the citizenship country', () => {
  assert.equal(picked(answerQuestion(text('In what countries do you have the unrestricted right to work?'), facts, job)), 'Kenya');
});

test('REGRESSION: a per-month salary box gets the monthly figure', () => {
  const monthly = text('What are your salary expectations? (Please state in PLN/month for a b2b contract, no UoP available)');
  const ctx = { ...job, salary: 'PLN 180,000 – 240,000', salaryRange: { min: 180_000, max: 240_000 }, salaryCurrency: 'PLN' };
  assert.equal(picked(answerQuestion(monthly, facts, ctx)), 'PLN 15,000 – 20,000 per month');
  assert.equal(picked(answerQuestion(text('What are your salary expectations?'), facts, ctx)), 'PLN 180,000 – 240,000');
});

test('public-official screening and live-near confirmation follow the stated facts', () => {
  const pep = q('Please tell us if you have been a Public Official or a Close Family Member of a Public Official in the last 5 years?');
  assert.equal(picked(answerQuestion(pep, facts, job)), 'No');
  assert.equal(picked(answerQuestion(pep, { ...facts, publicOfficial: true }, job)), 'Yes');
  const london = q('Please confirm you live near our London office location and understand the in-office expectation of Mondays, Tuesdays and Thursdays.');
  assert.equal(picked(answerQuestion(london, facts, job)), 'No');
  assert.equal(picked(answerQuestion(london, { ...facts, city: 'London' }, job)), 'Yes');
});

test('residence matches the country inside a longer option, on word boundaries', () => {
  const omanFacts = { ...facts, country: 'Oman' };
  const long = q('Where do you currently live?', { options: opts('Romania', 'Sultanate of Oman', 'Other') });
  assert.equal(picked(answerQuestion(long, omanFacts, job)), 'Sultanate of Oman');
});
