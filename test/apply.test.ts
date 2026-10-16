import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptProse, answerQuestion, type ApplicantFacts, type FormQuestion } from '../src/lib/apply/answers.ts';

const facts: ApplicantFacts = {
  firstName: 'Alex', lastName: 'K', email: 'a@example.com', phone: '+1 555 0100',
  linkedin: 'https://linkedin.com/in/x', github: 'https://github.com/x',
  city: 'Nairobi', country: 'Kenya', nationality: 'Kenyan',
  currentEmployer: 'Northwind', currentTitle: 'Software Developer', totalYears: 5.6,
  noticePeriod: 'One month', consentToRecording: false, willingOnsite: true, custom: {},
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
