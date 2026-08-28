import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatQuote, suggestQuote } from '../src/lib/jobs/quote.ts';

/**
 * The salary-expectation suggestion. The risks are the same family as
 * compensation.ts: a wrong number gets typed into a real application form. So
 * the posting's own band must always win over the market table, the currency
 * must always be the posting's own (never converted), and a figure the module
 * cannot ground -- unknown country, day rate -- must be no answer rather than a
 * guess.
 */

const MID = { candidateYears: 5.2 };

test('a posting-stated band anchors the quote inside it, in its own currency', () => {
  const q = suggestQuote({
    country: 'DE',
    description: 'DBA wanted, 4+ years experience. Salary 55.000 to 70.000 EUR.',
    structured: { min: 55_000, max: 70_000, currency: 'EUR' },
    ...MID,
  });
  assert.ok(q);
  assert.equal(q.basis, 'posting');
  assert.equal(q.currency, 'EUR');
  assert.ok(q.min >= 55_000 && q.max <= 70_000, `${q.min}-${q.max} escaped the employer's own band`);
  assert.ok(q.min < q.max);
});

test('the years ask positions inside the band: unmet years quote lower', () => {
  const base = {
    country: 'DE',
    structured: { min: 60_000, max: 90_000, currency: 'EUR' },
    ...MID,
  };
  const meets = suggestQuote({ ...base, description: 'minimum 4 years experience' })!;
  const misses = suggestQuote({ ...base, description: 'minimum 10 years experience' })!;
  assert.ok(misses.max < meets.max, 'asking beyond the candidate must not raise the quote');
});

test('no stated salary falls back to the market band for the country', () => {
  const q = suggestQuote({ country: 'DE', description: 'Backend Engineer, 4+ years, PHP and SQL.', ...MID });
  assert.ok(q);
  assert.equal(q.basis, 'market');
  assert.equal(q.currency, 'EUR');
  assert.equal(q.level, 'mid');
  assert.ok(q.min >= 50_000 && q.max <= 70_000);
});

test('the currency is always local — a Polish job quotes in PLN, an Indian one in INR', () => {
  assert.equal(suggestQuote({ country: 'PL', description: '', ...MID })!.currency, 'PLN');
  assert.equal(suggestQuote({ country: 'IN', description: '', ...MID })!.currency, 'INR');
  assert.equal(suggestQuote({ country: 'GB', description: '', ...MID })!.currency, 'GBP');
});

test('seniority moves the market band in the right direction', () => {
  const junior = suggestQuote({ country: 'DE', description: '', candidateYears: 1.5 })!;
  const mid = suggestQuote({ country: 'DE', description: '', candidateYears: 5 })!;
  const senior = suggestQuote({ country: 'DE', description: '', candidateYears: 9 })!;
  assert.ok(junior.max < mid.max);
  assert.ok(mid.max < senior.max);
});

test('an explicitly junior ask caps a senior candidate at mid money, not junior', () => {
  const q = suggestQuote({ country: 'DE', description: 'at least 2 years experience', candidateYears: 9 })!;
  assert.equal(q.level, 'mid');
});

test('a monthly figure in the text is annualised before anchoring', () => {
  const q = suggestQuote({
    country: 'DE',
    description: 'We pay 5.000 EUR per month.',
    extracted: { min: 5_000, max: null, currency: 'EUR', period: 'month', evidence: 'We pay 5.000 EUR per month.' },
    ...MID,
  })!;
  assert.equal(q.basis, 'posting');
  assert.ok(q.min >= 60_000, `${q.min} was not annualised`);
});

test('a day rate is NOT annualised — it falls back to the market band', () => {
  const q = suggestQuote({
    country: 'DE',
    description: 'Contract role, 600 EUR per day.',
    extracted: { min: 600, max: null, currency: 'EUR', period: 'day', evidence: '600 EUR per day' },
    ...MID,
  })!;
  assert.equal(q.basis, 'market');
});

test('an unknown country with no stated salary gives no answer, not a guess', () => {
  assert.equal(suggestQuote({ country: null, description: 'Great job.', ...MID }), null);
  assert.equal(suggestQuote({ country: 'XX', description: 'Great job.', ...MID }), null);
});

test('formatQuote prints the code and thousands separators, never a conversion', () => {
  const q = suggestQuote({ country: 'DE', description: '', ...MID })!;
  assert.match(formatQuote(q), /^EUR [\d,]+ – [\d,]+$/);
});
