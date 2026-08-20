import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CandidateProfile } from '../src/lib/resume/profile.ts';
import { isNegatedContext, verifyClaims, verifyProvenance } from '../src/lib/ai/verify.ts';

const here = dirname(fileURLToPath(import.meta.url));
const profile = CandidateProfile.parse(
  JSON.parse(readFileSync(join(here, '..', 'data', 'profile.v3.json'), 'utf8'))
);

test('an invented technology is blocked', () => {
  // Kubernetes is categorised as a tool, not a language. It must still block:
  // anything an interviewer can test is exactly what must not be fabricated.
  for (const [text, expected] of [
    ['I have four years of hands-on Kubernetes experience running production clusters.', 'Kubernetes'],
    ['Deep expertise in Microsoft SQL Server and T-SQL stored procedures.', 'Microsoft SQL Server'],
    ['I build production services in Java and deploy them with Docker.', 'Java'],
  ] as const) {
    const result = verifyClaims(profile, [text]);
    assert.equal(result.ok, false, `should have blocked: ${text}`);
    assert.ok(
      result.violations.some((v) => v.kind === 'unevidenced_skill' && v.detail.includes(expected)),
      `expected a violation naming ${expected}, got ${JSON.stringify(result.violations.map((v) => v.detail))}`
    );
  }
});

test('evidenced technologies pass untouched', () => {
  const result = verifyClaims(profile, [
    'Built a point-of-sale application with Electron.js, Node.js and PostgreSQL, and rebuilt an Oracle PL/SQL cost engine.',
  ]);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.ok(result.verifiedSkills.includes('PostgreSQL'));
  assert.ok(result.verifiedSkills.includes('PL/SQL'));
});

test('REGRESSION: honestly naming a gap is not a violation', () => {
  // These are real sentences the model produced. The first version of the
  // verifier flagged all of them, which would have blocked truthful output.
  const honest = [
    'No NoSQL experience of any kind is recorded, and the role explicitly covers managing NoSQL solutions.',
    'No AWS or GCP experience appears in your profile, and cloud platform experience is a stated qualification.',
    'No Terraform, Puppet or Bash automation in the profile.',
    'You would need to learn Docker before applying for this one.',
    'Be honest that you have not used MongoDB.',
  ];
  const result = verifyClaims(profile, honest);
  assert.equal(result.ok, true, `blocked honest text: ${JSON.stringify(result.violations, null, 2)}`);
  assert.ok(result.acknowledgedGaps.length > 0, 'gaps discussed honestly should be recorded');
});

test('REGRESSION: years of DATA is not years of EXPERIENCE', () => {
  // "15+ years of transactional data" is a fact about a dataset. The first
  // version read it as a 15-year career and blocked it.
  const result = verifyClaims(profile, [
    'Migrated 15+ years of historical transactional data across three modules with zero data loss.',
    'Split 15 years of records in Oracle without downtime.',
  ]);
  assert.equal(result.ok, true, `blocked a data-volume statement: ${JSON.stringify(result.violations)}`);
});

test('an inflated experience claim is still blocked', () => {
  const result = verifyClaims(profile, ['Software Developer with 12 years of professional experience in Oracle.']);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.kind === 'inflated_experience'));
});

test('the true experience figure passes', () => {
  const result = verifyClaims(profile, ['Software Developer with 5+ years of experience in Oracle and PL/SQL.']);
  assert.ok(!result.violations.some((v) => v.kind === 'inflated_experience'));
});

test('a work-authorisation claim is blocked', () => {
  for (const text of [
    'I hold a valid EU work permit.',
    'I am an EU citizen and need no sponsorship.',
    'I have the right to work in the EU.',
  ]) {
    const result = verifyClaims(profile, [text]);
    assert.equal(result.ok, false, text);
    assert.ok(result.violations.some((v) => v.kind === 'authorisation_claim'), text);
  }
});

test('stating the sponsorship requirement honestly is allowed', () => {
  const result = verifyClaims(profile, [
    'I would require visa sponsorship for this role and wanted to raise that early.',
  ]);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test('negation detection covers the shapes that actually occur', () => {
  assert.ok(isNegatedContext('No Docker experience is recorded'));
  assert.ok(isNegatedContext('You do not have Kubernetes'));
  assert.ok(isNegatedContext('This is a gap in the profile'));
  assert.ok(isNegatedContext('You would need to learn Terraform'));
  assert.ok(!isNegatedContext('Built a POS system in Electron.js and PostgreSQL'));
});

test('provenance tolerates a real rewrite but catches an invented source', () => {
  const realBullet = profile.experience[0]!.bullets[0]!;
  const legitimate = verifyProvenance(profile, [
    { rewritten: 'Owns development and production support of the core ERP platform.', original: realBullet },
  ]);
  assert.deepEqual(legitimate, [], 'a genuine citation must pass');

  const invented = verifyProvenance(profile, [
    { rewritten: 'Led a team of twelve engineers.', original: 'Managed a distributed team of twelve engineers across three continents.' },
  ]);
  assert.equal(invented.length, 1);
  assert.equal(invented[0]!.kind, 'untraceable_text');
});

test('REGRESSION: an employer name is not a skill claim', () => {
  // "Meridian" is a real employer in this profile, and the taxonomy has
  // `agile` as an alias for Agile/Scrum. Every honest sentence naming the
  // company was being reported as a fabricated Scrum claim.
  const result = verifyClaims(profile, [
    'At Meridian I did query performance optimisation and production uptime support for offshore clients.',
    'At Meridian Software Services I delivered six government modules.',
  ]);
  assert.ok(
    !result.violations.some((v) => /Agile/.test(v.detail)),
    `employer name misread as a skill: ${JSON.stringify(result.violations.map((v) => v.detail))}`
  );
});

test('REGRESSION: a hypothetical about a gap is not a claim', () => {
  // Verbatim from a generated cover letter. It is the candidate telling the
  // employer to weigh a gap, and it must not be blocked.
  const result = verifyClaims(profile, [
    'If cloud and NoSQL are day-one requirements rather than things to pick up, I am a partial match and you should weigh that.',
    'If Kubernetes is essential, I would need to learn it.',
  ]);
  assert.equal(result.ok, true, `blocked an honest hypothetical: ${JSON.stringify(result.violations.map((v) => v.detail))}`);
});

test('a hypothetical wrapper does not launder a real claim', () => {
  // The generosity above must not become a loophole: an actual assertion in its
  // own clause still blocks even when a nearby clause is hypothetical.
  const result = verifyClaims(profile, [
    'If you need cloud, that is a gap. I have three years of production Kubernetes experience.',
  ]);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => /Kubernetes/.test(v.detail)));
});

test('REGRESSION: a colon does not sever a label from its own denial', () => {
  // Verbatim output from the summary stage. Splitting clauses on ':' left
  // "Cloud platforms (AWS/GCP):" as a fragment with no negation in it, so six
  // blocking violations were raised against text that is entirely honest.
  const honest = [
    'Cloud platforms (AWS/GCP): the role requires hands-on experience with one of these; your profile shows none.',
    "NoSQL databases: the posting lists 'familiarity with NoSQL solutions' as a requirement. Your profile contains no MongoDB, Cassandra, Redis, or other NoSQL work.",
    'Terraform/Puppet: listed as a plus. Your profile shows no infrastructure-as-code experience.',
  ];
  const result = verifyClaims(profile, honest);
  assert.equal(
    result.ok,
    true,
    `blocked honest gap analysis: ${JSON.stringify(result.violations.map((v) => v.detail))}`
  );
});

test('a sentence boundary still separates a denial from a claim', () => {
  // The colon fix must not make negation leak across whole sentences.
  const result = verifyClaims(profile, [
    'Cloud: your profile shows none. I have four years of production Kubernetes experience.',
  ]);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => /Kubernetes/.test(v.detail)));
});

test('quoting the employer is not claiming the skill', () => {
  const result = verifyClaims(profile, [
    "The posting lists 'familiarity with NoSQL solutions' as a requirement.",
    'The role requires hands-on Kubernetes and Terraform.',
    'Docker is listed as desirable.',
    'They are looking for someone with AWS certification.',
  ]);
  assert.equal(result.ok, true, `blocked a quote of the employer: ${JSON.stringify(result.violations.map((v) => v.detail))}`);
});

test('the employer exemption does not launder a candidate claim', () => {
  const result = verifyClaims(profile, [
    'The role requires Kubernetes. I have run Kubernetes in production for four years.',
  ]);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => /Kubernetes/.test(v.detail)));
});
