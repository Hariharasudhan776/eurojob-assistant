import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProfileUpload } from '../src/lib/resume/upload.ts';

/**
 * A profile now arrives over HTTP from any user, so the guarantee that used to
 * come from a hand-maintained local file has to come from validation. The rule
 * being protected: **no skill without evidence**, because that is what stops a
 * generated resume claiming something the candidate cannot back up.
 */

const minimal = {
  name: 'Test Person',
  headline: 'Database Developer',
  email: 'test@example.com',
  phone: '+1 555 0100',
  location: 'Dublin, Ireland',
  links: { linkedin: null, github: null },
  summary: 'Does database work.',
  experience: [
    {
      company: 'Some Employer',
      title: 'Developer',
      location: 'Dublin, Ireland',
      startDate: '2020-01',
      endDate: '2024-01',
      current: false,
      context: 'A team.',
      bullets: ['Did a thing.'],
      skills: ['sql'],
    },
  ],
  skills: [
    { name: 'PostgreSQL', category: 'database', years: 4, level: 'strong', evidence: 'Some Employer: schemas and query tuning.' },
  ],
  workAuthorisation: {
    euCitizen: false,
    euWorkPermit: false,
    needsSponsorship: true,
    currentCountry: 'India',
    notes: '',
  },
};

test('a minimal profile is accepted, and the derived fields are filled in', () => {
  const result = parseProfileUpload(JSON.stringify(minimal));
  assert.equal(result.errors.length, 0);
  assert.ok(result.profile);
  // canonical is bookkeeping, not a claim, so the taxonomy supplies it.
  assert.equal(result.profile!.skills[0]!.canonical, 'postgresql');
  // Years come from the dates, never from a typed-in number: 2020-01 through
  // 2024-01 inclusive is 49 months, which is 4.1 years, not "about 4".
  assert.equal(result.profile!.totalYears, 4.1);
  assert.ok(result.filledIn.some((f) => f.startsWith('totalYears')));
});

test('a skill with no evidence is REJECTED, with a message that says why', () => {
  const bad = { ...minimal, skills: [{ name: 'MongoDB', category: 'database', years: 1, level: 'familiar' }] };
  const result = parseProfileUpload(JSON.stringify(bad));
  assert.equal(result.profile, null);
  assert.ok(result.errors.some((e) => e.includes('evidence')));
  // The message has to be actionable, not just "invalid".
  assert.ok(result.errors.some((e) => e.includes('cannot be skipped')));
});

test('an empty evidence string is not evidence', () => {
  const bad = { ...minimal, skills: [{ ...minimal.skills[0]!, evidence: '' }] };
  assert.equal(parseProfileUpload(JSON.stringify(bad)).profile, null);
});

test('a supplied totalYears cannot exceed what the dates support', () => {
  // The resume says 5+ years because the dates say so. A profile claiming 15
  // years off four years of employment is corrected, not trusted.
  const inflated = { ...minimal, totalYears: 15 };
  const result = parseProfileUpload(JSON.stringify(inflated));
  assert.equal(result.profile!.totalYears, 4.1);
});

test('malformed input is refused with the parser error, not a stack trace', () => {
  const result = parseProfileUpload('{not json');
  assert.equal(result.profile, null);
  assert.ok(result.errors[0]!.includes('not valid JSON'));
});

test('a JSON array is not a profile', () => {
  const result = parseProfileUpload('[]');
  assert.equal(result.profile, null);
  assert.ok(result.errors[0]!.includes('single JSON object'));
});

test('an oversized file is refused before it is parsed', () => {
  const huge = 'x'.repeat(600 * 1024);
  const result = parseProfileUpload(huge);
  assert.equal(result.profile, null);
  assert.ok(result.errors[0]!.includes('KB'));
});

test('a first upload defaults to version 1, and a later one is given the next version', () => {
  assert.equal(parseProfileUpload(JSON.stringify(minimal)).profile!.version, 1);
  assert.equal(parseProfileUpload(JSON.stringify(minimal), 4).profile!.version, 4);
});

test('bad dates are reported in the format the schema wants', () => {
  const bad = {
    ...minimal,
    experience: [{ ...minimal.experience[0]!, startDate: '2020' }],
  };
  const result = parseProfileUpload(JSON.stringify(bad));
  assert.equal(result.profile, null);
  assert.ok(result.errors.some((e) => e.includes('YYYY-MM')));
});
