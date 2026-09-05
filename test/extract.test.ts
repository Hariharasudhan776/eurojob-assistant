import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractCvText } from '../src/lib/resume/extract.ts';
import { parseProfileUpload } from '../src/lib/resume/upload.ts';

/**
 * Reading a CV file.
 *
 * The dangerous failure here is not refusing a file, it is accepting one badly:
 * a scanned CV yields a handful of stray characters, and sending those to a
 * model produces a confident, entirely fictional profile. So a poor read must
 * fail loudly rather than degrade quietly.
 */

const bytes = (s: string) => new TextEncoder().encode(s);

test('a file type that cannot be read is refused with a way forward', async () => {
  const result = await extractCvText('resume.doc', bytes('anything'));
  assert.equal(result.text, '');
  assert.match(result.errors[0] ?? '', /\.docx/);
  // The old binary .doc is the common case, so the message must name the fix.
  assert.match(result.errors[0] ?? '', /Save As/i);
});

test('an empty or oversized file is refused before anything else happens', async () => {
  assert.match((await extractCvText('cv.pdf', new Uint8Array(0))).errors[0] ?? '', /empty/i);

  const huge = new Uint8Array(9 * 1024 * 1024);
  huge.set(bytes('%PDF'), 0);
  assert.match((await extractCvText('cv.pdf', huge)).errors[0] ?? '', /8MB/);
});

test('a file that yields almost no text is reported, not passed on', async () => {
  // This is the scanned-CV case: it parses, and produces nothing usable. Left
  // unchecked it reaches the model, which will invent a career to fill the gap.
  const result = await extractCvText('cv.txt', bytes('Alex Kumar'));
  assert.ok(result.errors.length > 0, 'a near-empty read must be an error');
  assert.match(result.errors[0] ?? '', /scanned|pixels/i);
});

test('the file header decides the type, not the extension', async () => {
  // A PDF saved as "cv.txt" is still a PDF, and reading it as text yields
  // binary noise that looks like a very short CV.
  const pdfHeader = new Uint8Array(300);
  pdfHeader.set(bytes('%PDF-1.7'), 0);
  const result = await extractCvText('cv.txt', pdfHeader);
  assert.equal(result.kind, 'pdf');
});

test('plain text survives extraction intact', async () => {
  const cv = [
    'ALEX KUMAR',
    'Software Developer',
    '',
    'EXPERIENCE',
    'Northwind Construction Group — Software Developer, Jun 2025 to present',
    'Administered 5+ Oracle Database instances across four countries.',
    'Developed PL/SQL stored procedures, functions and triggers.',
  ].join('\n');

  const result = await extractCvText('cv.txt', bytes(cv.padEnd(250, ' ')));
  assert.equal(result.errors.length, 0);
  assert.match(result.text, /Northwind/);
  assert.match(result.text, /stored procedures/);
});

/**
 * The review step is what keeps the guarantee, so the thing worth testing is
 * that a draft cannot bypass it: whatever the reviewer confirms still goes
 * through the same upload validation a hand-written file always did.
 */
test('a confirmed draft is still held to the evidence rule', () => {
  const withoutEvidence = JSON.stringify({
    name: 'A Candidate',
    headline: 'Developer',
    email: 'a@example.com',
    phone: '+1',
    location: 'Berlin, Germany',
    links: { linkedin: null, github: null },
    summary: 'Summary.',
    experience: [
      {
        company: 'ACME',
        title: 'Developer',
        location: 'Berlin',
        startDate: '2021-01',
        endDate: null,
        current: true,
        context: '',
        bullets: ['Did a thing.'],
        skills: [],
      },
    ],
    // No evidence: this is exactly what a model would emit if the prompt failed.
    skills: [{ name: 'Oracle Database', category: 'database', years: 3, level: 'strong' }],
    projects: [],
    education: [],
    certifications: [],
    languages: [],
    employmentGaps: [],
    workAuthorisation: {
      euCitizen: false,
      euWorkPermit: false,
      needsSponsorship: true,
      currentCountry: 'Germany',
      notes: '',
    },
  });

  const result = parseProfileUpload(withoutEvidence);
  assert.equal(result.profile, null, 'a skill with no evidence must not be saved');
  assert.ok(result.errors.some((e) => /evidence/i.test(e)));
});

test('the taxonomy key is derived, never taken from the draft', () => {
  // The draft type has no `canonical` field on purpose: a guessed match key
  // could make a skill satisfy the wrong job requirement.
  const profile = JSON.stringify({
    name: 'A Candidate',
    headline: 'Developer',
    email: 'a@example.com',
    phone: '+1',
    location: 'Berlin, Germany',
    links: { linkedin: null, github: null },
    summary: 'Summary.',
    experience: [
      {
        company: 'ACME',
        title: 'Developer',
        location: 'Berlin',
        startDate: '2021-01',
        endDate: null,
        current: true,
        context: '',
        bullets: ['Did a thing.'],
        skills: [],
      },
    ],
    skills: [
      { name: 'PostgreSQL', category: 'database', years: 3, level: 'strong', evidence: 'Used daily at ACME.' },
    ],
    projects: [],
    education: [],
    certifications: [],
    languages: [],
    employmentGaps: [],
    workAuthorisation: {
      euCitizen: false,
      euWorkPermit: false,
      needsSponsorship: true,
      currentCountry: 'Germany',
      notes: '',
    },
  });

  const result = parseProfileUpload(profile);
  assert.ok(result.profile, result.errors.join(' '));
  assert.equal(result.profile.skills[0]?.canonical, 'postgresql');
  assert.ok(result.filledIn.some((f) => /canonical/i.test(f)), 'the derivation must be reported, not silent');
});
