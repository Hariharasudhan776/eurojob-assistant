import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { extractSkillMentions, extractSkills, display } from '../src/lib/match/taxonomy.ts';
import { scoreJob } from '../src/lib/match/score.ts';
import { buildMirrorPlan, forbiddenBriefing, mirrorBriefing } from '../src/lib/resume/mirror.ts';
import { auditResume } from '../src/lib/resume/audit.ts';
import { CandidateProfile } from '../src/lib/resume/profile.ts';
import type { NormalisedJob } from '../src/lib/jobs/types.ts';

/**
 * Vocabulary mirroring.
 *
 * The behaviour under test is the one that caused seven rejections: a candidate
 * who genuinely owns production Oracle backup and recovery produced resumes that
 * never contained a word the employer had written, because every requirement was
 * relabelled into this app's vocabulary before it reached the document.
 *
 * The tests come in two halves and both halves matter. One half proves the
 * employer's word now survives when it is earned. The other proves it does NOT
 * survive when it is not -- which is the whole reason this is a code path and
 * not a line in a prompt.
 */

const profile = CandidateProfile.parse(JSON.parse(readFileSync('data/profile.v3.json', 'utf8')));

const dbaJob = (description: string, title = 'Senior Oracle Database Administrator'): NormalisedJob => ({
  sourceSlug: 'test',
  sourceJobId: '1',
  url: 'https://example.test/1',
  title,
  company: 'ACME GmbH',
  country: 'DE',
  city: 'Berlin',
  remote: 'onsite',
  employmentType: 'full_time',
  salaryMin: null,
  salaryMax: null,
  salaryCurrency: null,
  description,
  descriptionComplete: true,
  languages: ['English'],
  visaSponsorship: 'not_specified',
  relocationSupport: 'not_specified',
  postedAt: new Date('2026-08-01'),
  raw: {},
});

const DBA_DESCRIPTION = `Requirements:
- 5+ years as an Oracle DBA
- Strong RMAN backup and recovery, Data Guard and ASM
- AWR/ADDM analysis and SQL tuning
- Data Pump (expdp/impdp) migrations
- PL/SQL development
- Linux administration
Nice to have:
- Kubernetes`;

const planFor = (description: string, title?: string) => {
  const job = dbaJob(description, title);
  const match = scoreJob(profile, job, { preferredCountries: ['DE'] });
  return { job, match, plan: buildMirrorPlan(match.requirements.required, match.requirements.preferred, profile) };
};

// --- the vocabulary itself -------------------------------------------------

test('Oracle DBA tooling a posting screens for is no longer invisible', () => {
  // Every one of these returned nothing before this change, so a posting could
  // demand five specific things and the app would report full coverage.
  for (const term of ['RMAN', 'Data Guard', 'ASM', 'AWR', 'ADDM', 'Data Pump', 'expdp', 'high availability']) {
    assert.ok(extractSkills(term).length > 0, `${term} is not recognised by the matcher`);
  }
});

test("the employer's own spelling is preserved, not just the canonical key", () => {
  const mentions = extractSkillMentions('We need RMAN and expdp experience, plus AWR analysis.');
  const byCanonical = new Map(mentions.map((m) => [m.canonical, m.surface]));

  assert.deepEqual(byCanonical.get('oracle-rman'), ['RMAN']);
  assert.ok(byCanonical.get('oracle-datapump')?.includes('expdp'));
  assert.ok(byCanonical.get('oracle-awr')?.includes('AWR'));
  // The canonical display name is ours; the surface must be theirs.
  assert.equal(display('oracle-rman'), 'Oracle RMAN');
});

// --- mirror: the employer's word, when it is earned ------------------------

test('a skill held under a different name is relabelled to the posting word', () => {
  const { plan } = planFor(DBA_DESCRIPTION);
  const terms = plan.mirror.map((e) => (e.term ?? '').toLowerCase());

  // Held as "Performance tuning"; the advert says "SQL tuning".
  assert.ok(terms.includes('sql tuning'), `expected the SQL tuning relabel, got ${terms.join(', ')}`);
  // Every mirror entry must name the profile skill it leans on.
  for (const entry of plan.mirror) {
    assert.ok(entry.heldSkill, `mirror entry ${entry.display} has no profile skill behind it`);
    assert.ok(entry.heldEvidence, `mirror entry ${entry.display} has no evidence behind it`);
    assert.equal(entry.weight, 1);
  }
});

test('mirroring may relabel a fact but never sharpen one', () => {
  // "Oracle 19c" is an alias of the same canonical as "Oracle", so without a
  // guard it would qualify to be printed -- asserting a release the profile
  // does not evidence.
  const { plan } = planFor('Requirements:\n- Oracle 19c administration\n- PL/SQL');
  const oracle = plan.mirror.find((e) => e.requirement === 'oracle');

  assert.ok(oracle, 'Oracle should be mirrored, it is held exactly');
  assert.ok(!/19c/i.test(oracle.term ?? ''), `version pinned without evidence: ${oracle.term}`);
});

// --- confirm: the near-miss that must be asked, never assumed --------------

test('RMAN is asked about, not claimed, when only backup experience is recorded', () => {
  const { plan } = planFor(DBA_DESCRIPTION);

  const rman = plan.confirm.find((e) => e.requirement === 'oracle-rman');
  assert.ok(rman, 'RMAN must be a question, not a silent pass');
  assert.equal(rman.term, null, 'a confirm entry must never carry a printable term');
  assert.match(rman.question ?? '', /Backup & recovery/i);

  // And it must NOT be sitting in the mirror list under any spelling.
  assert.ok(
    !plan.mirror.some((e) => e.requirement === 'oracle-rman'),
    'RMAN was treated as already satisfied'
  );
});

test('every unconfirmed term is named in the forbidden briefing', () => {
  const { plan } = planFor(DBA_DESCRIPTION);
  const briefing = forbiddenBriefing(plan);

  for (const term of ['RMAN', 'Data Guard', 'ASM', 'Kubernetes']) {
    assert.match(briefing, new RegExp(`\\b${term}\\b`, 'i'), `${term} is not forbidden to the model`);
  }
  // The mirror briefing and the forbidden briefing must not overlap.
  //
  // The boundaries are not decoration: "perfo(rman)ce" contains "rman", so a
  // substring test reports a leak on the entirely innocent sentence about
  // performance tuning. The production check in services.ts has always used
  // boundaries; this test briefly did not, and failed on its own naivety.
  const mirrored = mirrorBriefing(plan);
  assert.ok(!/\bRMAN\b/i.test(mirrored), 'RMAN leaked into the permitted list');
});

test('a requirement with nothing behind it is a gap, never a question', () => {
  const { plan } = planFor(DBA_DESCRIPTION);

  const k8s = plan.gaps.find((e) => e.requirement === 'kubernetes');
  assert.ok(k8s, 'Kubernetes should be a plain gap');
  assert.equal(k8s.heldSkill, null);
  assert.equal(k8s.term, null);
});

// --- audit: grading the document, not the profile --------------------------

const tailoredFixture = (over: Record<string, unknown> = {}) => ({
  targetTitle: 'Oracle Database Administrator | PL/SQL',
  summary:
    '5.2 years building and administering Oracle databases, currently at Northwind Construction Group. ' +
    'Owns backup and recovery and SQL tuning for a production Oracle estate, and migrated 15+ years of data across three modules.',
  skillOrder: ['Oracle Database', 'PL/SQL', 'Performance tuning'],
  skillLabels: [{ profileSkill: 'Performance tuning', printAs: 'SQL tuning' }],
  bullets: [{ company: 'Northwind Construction Group', bullets: ['Migrated 15+ years of transactional data across 3 modules with zero data loss.'] }],
  projectOrder: [],
  keywordsUsed: ['SQL tuning'],
  emphasis: [],
  provenance: [],
  omitted: [],
  ...over,
});

test('the audit reads the document, not the model’s account of it', () => {
  const { job, plan } = planFor(DBA_DESCRIPTION);
  const tailored = tailoredFixture({
    // The model claims RMAN was used; the text below contains no such thing.
    keywordsUsed: ['RMAN', 'Data Guard', 'SQL tuning'],
  }) as never;

  const text = 'Oracle Database Administrator | PL/SQL\nbackup and recovery, SQL tuning';
  const audit = auditResume(profile, tailored, plan, job, text);

  const claimed = audit.keywords.find((k) => /rman/i.test(k.term));
  assert.ok(!claimed, 'an unmirrored term must not be audited as covered');
  assert.ok(audit.unanswered.some((t) => /RMAN/i.test(t)), 'RMAN should be reported as a keyword going spare');
});

test('a resume whose headline ignores the advert is graded down', () => {
  const { job, plan } = planFor(DBA_DESCRIPTION);
  const tailored = tailoredFixture({ targetTitle: 'Software Developer' }) as never;

  const audit = auditResume(profile, tailored, plan, job, 'Software Developer');
  const titleCheck = audit.checks.find((c) => c.label.startsWith('Headline'));

  assert.ok(titleCheck && !titleCheck.pass, 'a headline sharing nothing with the advert should fail');
});

test('duty language is caught', () => {
  const { job, plan } = planFor(DBA_DESCRIPTION);
  const tailored = tailoredFixture({
    bullets: [{ company: 'Northwind Construction Group', bullets: ['Responsible for the production database.'] }],
  }) as never;

  const audit = auditResume(profile, tailored, plan, job, 'x');
  const check = audit.checks.find((c) => c.label === 'No duty-list openers');
  assert.ok(check && !check.pass);
});

test('an employer is recognised without its legal suffix', () => {
  // Gemini wrote "Northwind Construction Group"; the profile says
  // "...Contracting Co.". An exact substring test failed a summary that names
  // the employer perfectly well, which is a fault in the check, not the resume.
  const { job, plan } = planFor(DBA_DESCRIPTION);
  const company = (profile.experience.find((e) => !e.endDate) ?? profile.experience[0])!.company;
  const withoutSuffix = company.replace(/\s*(?:Co\.?|Ltd\.?|GmbH|LLC|Inc\.?)\s*$/i, '');

  const tailored = tailoredFixture({
    summary: `Database Administrator with 5+ years of experience, currently at ${withoutSuffix}.`,
  }) as never;

  const audit = auditResume(profile, tailored, plan, job, 'x');
  const check = audit.checks.find((c) => c.label === 'Current employer named in the summary');
  assert.ok(check?.pass, `naming "${withoutSuffix}" should satisfy the employer check`);
});

test('modern data-platform terms are visible so their absence is reported', () => {
  // A requirement the taxonomy cannot see is never scored and never shown as a
  // gap, so a blind spot always flatters the candidate.
  for (const term of ['Terraform', 'Kafka', 'Snowflake', 'Airflow', 'Databricks', 'GraphQL', 'Exadata']) {
    assert.ok(extractSkills(term).length > 0, `${term} is invisible to the matcher`);
  }

  const { plan } = planFor('Requirements:\n- Oracle DBA\n- Terraform and Kafka in production\n- Snowflake');
  const gapNames = plan.gaps.map((g) => (g.surface[0] ?? g.display).toLowerCase());
  for (const term of ['terraform', 'kafka', 'snowflake']) {
    assert.ok(gapNames.includes(term), `${term} should be reported as a gap, got ${gapNames.join(', ')}`);
  }
});
