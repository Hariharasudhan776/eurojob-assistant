import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectVisaSponsorship, detectRelocationSupport } from '../src/lib/jobs/parse.ts';

/**
 * Visa sponsorship detection.
 *
 * For a candidate who needs sponsorship this is the single most valuable field
 * in the app, and it was almost entirely blank: of 22,428 collected postings,
 * 310 said "no", **7** said "yes", and 22,111 said nothing.
 *
 * Every sentence in this file is REAL, taken verbatim from the live feed. That
 * matters more here than in most tests: the first diagnosis of this problem was
 * wrong precisely because it counted keyword hits instead of reading sentences.
 * A grep for "visa|sponsor" returned 247 postings and the conclusion drawn was
 * "the parser misses acceptance". Reading them showed something else entirely --
 * most were executive sponsors, sponsored lunches, and Visa Inc. the employer.
 * The genuine number was 404, and the largest missed category was not YES but
 * NO: right-to-work requirements phrased in ways the patterns did not cover.
 */

// --- the noise that dominated the first measurement ------------------------

test('the business senses of "sponsor" are not immigration', () => {
  for (const sentence of [
    'Act as an executive technical sponsor on flagship and expansion deals.',
    'You will also act as a senior sponsor on our most critical customer programs.',
    'Sponsored access to EGYM Wellpass to prioritize your wellbeing.',
    'Lunch-Card: daily lunch budget is sponsored.',
    'Lead negotiations with borrowers, sponsors and advisers during restructuring.',
    'Exceptional communicator who earns executive sponsorship and champions customer success.',
    'Drive partner-led demand generation — industry events, co-funded campaigns and regional kickoff sponsorships.',
  ]) {
    assert.equal(detectVisaSponsorship(sentence), 'not_specified', `misread as immigration: ${sentence}`);
  }
});

test('Visa the employer is not visa the document', () => {
  // Visa Inc. postings say the word dozens of times without discussing
  // immigration once, and there are enough of them in the feed to matter.
  const posting = `Join Visa and do work that matters - to you, to your community, and to the world.
Visa Government Solutions brings Visa's consumer, commercial and money movement solutions to public sector clients.
As Visa moves from planning to execution of its 2030 roadmap, you will contribute to a strategic priority.
Visa requires at least 3 days in office, expectations of these days will be confirmed by your Hiring Manager.`;
  assert.equal(detectVisaSponsorship(posting), 'not_specified');
});

// --- the expensive false negative ------------------------------------------

test('US right-to-work boilerplate is not a refusal to sponsor', () => {
  // This clause appears on postings that sponsor perfectly happily. It says the
  // offer is contingent on eventually being authorised -- not that the employer
  // will not help you become authorised. Reading it as "no" would hide good jobs
  // from the one candidate the field exists to serve, which is the more
  // expensive of the two possible errors.
  for (const sentence of [
    "All offers of employment are contingent upon an individual's ability to secure and maintain the legal right to work at the company and in the specified work location, if applicable.",
    'Right to Work Notice (English/Spanish)',
    'Is role eligible for Immigration Sponsorship?',
  ]) {
    assert.equal(detectVisaSponsorship(sentence), 'not_specified', `boilerplate read as refusal: ${sentence}`);
  }
});

test('an explicit yes outranks boilerplate elsewhere in the same posting', () => {
  const posting = `Visa sponsorship: We do sponsor visas!
However, we aren't able to successfully sponsor visas for every role and every candidate.
All offers of employment are contingent upon an individual's ability to secure and maintain the legal right to work.`;
  assert.equal(detectVisaSponsorship(posting), 'yes');
});

// --- the yes cases that were being missed ----------------------------------

test('an employer that says it sponsors is recorded as yes', () => {
  for (const sentence of [
    'Visa sponsorship: We do sponsor visas!',
    '✅ We can sponsor visas',
    'Visa sponsorship may be available for select positions based on business needs and specific role requirements.',
    'Relocation assistance is provided for those willing to relocate including visa sponsorship where applicable.',
  ]) {
    assert.equal(detectVisaSponsorship(sentence), 'yes', `missed a yes: ${sentence}`);
  }
});

test('REGRESSION: a negated availability line is not an offer', () => {
  // "No visa sponsorship is available for this position" ENDS in the literal
  // words "visa sponsorship is available". The yes-patterns run before the
  // negative ones, so an unguarded match here wins outright and cannot be
  // rescued later -- a real Oracle posting refusing sponsorship was read as
  // offering it, caught only by spot-checking the flips before writing them.
  for (const sentence of [
    'No visa sponsorship is available for this position.',
    'Not including visa sponsorship.',
  ]) {
    assert.notEqual(detectVisaSponsorship(sentence), 'yes', `negation ignored: ${sentence}`);
  }
});

test('a conditional offer is still an offer', () => {
  // n8n sponsors for one country and not others. "Yes" is right: the candidate
  // targets Germany, and this posting was previously recorded as a flat "no"
  // because the second clause tripped a right-to-work pattern.
  const sentence =
    'We can sponsor visas to Germany; for any other country, you need to have existing right to work.';
  assert.equal(detectVisaSponsorship(sentence), 'yes');
});

// --- the no cases that were being missed -----------------------------------

test('a right-to-work REQUIREMENT is a refusal, unlike the boilerplate', () => {
  for (const sentence of [
    'Also please note that at this time, we cannot support candidates requiring visa sponsorship or relocation.',
    'Please note this is a UK based role and requires individuals to have the right to work in this location.',
    "To join Webflow, you'll need a valid right to work authorization depending on the country of employment.",
    'Google will be prioritizing applicants who have a current right to work in Singapore, and do not require Google\'s sponsorship of a visa.',
    'Presence in Berlin & valid work permit for Germany is required!',
    'However, we do require you to have a UK work permit.',
    'Ability to work onsite in our London office 5 days a week (must be UK-based with right to work).',
  ]) {
    assert.equal(detectVisaSponsorship(sentence), 'no', `missed a no: ${sentence}`);
  }
});

// --- relocation, a separate question ---------------------------------------

test('relocation is read in both directions, including labelled fields', () => {
  assert.equal(detectRelocationSupport('Relocation Assistance Provided: No'), 'no');
  assert.equal(detectRelocationSupport('Relocation assistance will not be provided for this role.'), 'no');
  assert.equal(detectRelocationSupport('A relocation stipend may be available for those willing to relocate.'), 'yes');
  assert.equal(detectRelocationSupport('Relocation expense coverage to NYC or SF (if needed)'), 'yes');
  assert.equal(detectRelocationSupport('Let us help you move to one of our hubs with relocation support'), 'yes');
  assert.equal(detectRelocationSupport('Relocation Support: comprehensive relocation support to make your move to Berlin seamless.'), 'yes');
});

test('sponsorship and relocation stay independent', () => {
  // An employer can pay for the move and still refuse the visa, and the
  // candidate needs to know which is which. Collapsing them would be the same
  // error as collapsing "not specified" into "no".
  const sentence = 'We offer a generous relocation package, but we are unable to offer visa sponsorship.';
  assert.equal(detectRelocationSupport(sentence), 'yes');
  assert.equal(detectVisaSponsorship(sentence), 'no');
});
