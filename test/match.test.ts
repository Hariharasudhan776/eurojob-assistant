import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalise, extractSkills, transferWeight } from '../src/lib/match/taxonomy.ts';
import { assessRelevance, classifyTitle, shrinkRatio } from '../src/lib/match/relevance.ts';
import { extractRequirements, scoreJob } from '../src/lib/match/score.ts';
import { CandidateProfile } from '../src/lib/resume/profile.ts';
import type { NormalisedJob } from '../src/lib/jobs/types.ts';
import { detectRequiredLanguages, splitSentences } from '../src/lib/jobs/parse.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const profile = CandidateProfile.parse(
  JSON.parse(readFileSync(join(here, '..', 'data', 'profile.v3.json'), 'utf8'))
);

const COUNTRIES = ['DE', 'NL', 'SE', 'IE', 'AT', 'CH'];

function job(over: Partial<NormalisedJob> = {}): NormalisedJob {
  return {
    sourceSlug: 'test',
    sourceJobId: 'j1',
    url: 'https://example.com/job/1',
    title: 'Oracle PL/SQL Developer',
    company: 'Example GmbH',
    country: 'DE',
    city: 'Berlin',
    remote: 'hybrid',
    employmentType: 'full_time',
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    description: 'We need Oracle and PL/SQL experience.',
    descriptionComplete: true,
    languages: [],
    visaSponsorship: 'not_specified',
    relocationSupport: 'not_specified',
    postedAt: new Date('2026-08-01T00:00:00Z'),
    raw: {},
    ...over,
  };
}

// --- taxonomy -------------------------------------------------------------

test('canonicalise unifies the spellings employers actually use', () => {
  for (const variant of ['PL/SQL', 'pl sql', 'Oracle PL/SQL', 'plsql']) {
    assert.equal(canonicalise(variant), 'plsql', variant);
  }
  assert.equal(canonicalise('Postgres'), 'postgresql');
  assert.equal(canonicalise('Oracle Database'), 'oracle');
  assert.equal(canonicalise('totally made up'), null);
});

test('skill extraction respects word boundaries', () => {
  // The classic false positive: "C" must not match inside other words, and
  // "oracles" is not "oracle".
  assert.ok(!extractSkills('we value clear communication').includes('c'));
  assert.ok(extractSkills('strong C and C++ background').includes('c'));
  assert.ok(extractSkills('strong C and C++ background').includes('cpp'));
  assert.ok(!extractSkills('he consults oracles for fun').includes('oracle'));
  assert.ok(extractSkills('Oracle, PostgreSQL and Node.js').includes('oracle'));
});

test('transfer weights are symmetric and bounded', () => {
  assert.equal(transferWeight('oracle', 'oracle'), 1);
  assert.equal(transferWeight('oracle', 'postgresql'), transferWeight('postgresql', 'oracle'));
  assert.ok(transferWeight('oracle', 'postgresql') > 0 && transferWeight('oracle', 'postgresql') < 1);
  assert.equal(transferWeight('oracle', 'css'), 0);
});

// --- relevance ------------------------------------------------------------

test('non-technical titles are classified as such even when they mention tech', () => {
  assert.equal(classifyTitle('Junior Community Manager*in/ Social Media (all genders)'), 'non_technical');
  assert.equal(classifyTitle('Video Editor / Cutter Social Media (m/w/d)'), 'non_technical');
  assert.equal(classifyTitle('Produktmanager – PC-Hardware (m/w/d)'), 'non_technical');
  // A positive keyword must not rescue a non-technical title.
  assert.equal(classifyTitle('Head of Product - SQL a plus'), 'non_technical');
});

test('technical and adjacent titles are recognised', () => {
  assert.equal(classifyTitle('Senior Database Administrator'), 'technical');
  assert.equal(classifyTitle('Oracle PL/SQL Developer (m/w/d)'), 'technical');
  assert.equal(classifyTitle('Softwareentwickler Backend'), 'technical');
  assert.equal(classifyTitle('ERP Technical Consultant'), 'adjacent');
});

test('a posting with no technical requirement is out of scope', () => {
  // 'reporting' is a domain skill: real, but it says nothing about whether the
  // role is engineering.
  const verdict = assessRelevance('Brand Activation Manager', ['reporting']);
  assert.equal(verdict.outOfScope, true);
  assert.equal(verdict.technicalRequirements.length, 0);

  const ok = assessRelevance('Database Developer', ['oracle', 'plsql']);
  assert.equal(ok.outOfScope, false);
  assert.deepEqual(ok.technicalRequirements, ['oracle', 'plsql']);
});

test('shrinkRatio discounts thin evidence but trusts thick evidence', () => {
  const thin = shrinkRatio(1, 1);
  const thick = shrinkRatio(8, 10);
  assert.ok(thin < 0.7, `one-of-one should not read as near-certain, got ${thin}`);
  assert.ok(thick > thin, 'eight of ten must outrank one of one');
  assert.ok(Math.abs(shrinkRatio(45, 50) - 0.9) < 0.05, 'large samples converge on the true ratio');
  assert.equal(shrinkRatio(0, 0), 0.45, 'no data falls back to the neutral prior');
});

// --- requirement extraction ----------------------------------------------

test('nice-to-haves are separated from requirements', () => {
  const parsed = extractRequirements(
    job({
      title: 'Backend Developer',
      description: [
        'Requirements:',
        '- Strong Oracle and PL/SQL',
        '- Solid SQL',
        'Nice to have:',
        '- Docker',
        '- Kubernetes',
      ].join('\n'),
    })
  );
  assert.ok(parsed.required.includes('oracle'));
  assert.ok(parsed.required.includes('plsql'));
  assert.ok(parsed.preferred.includes('docker'), `docker should be preferred, got ${parsed.preferred.join(',')}`);
  assert.ok(!parsed.required.includes('docker'), 'a nice-to-have must not count as required');
});

// --- scoring --------------------------------------------------------------

test('a real Oracle role scores well and is recommended', () => {
  const result = scoreJob(
    profile,
    job({
      title: 'Oracle PL/SQL Developer',
      description: [
        'Requirements:',
        '- 4+ years of Oracle and PL/SQL development',
        '- Strong SQL and performance tuning',
        '- Experience with data migration',
        'We offer visa sponsorship and relocation support.',
      ].join('\n'),
      visaSponsorship: 'yes',
      relocationSupport: 'yes',
    }),
    { preferredCountries: COUNTRIES }
  );
  assert.ok(result.overall >= 80, `expected a strong score, got ${result.overall}`);
  assert.equal(result.recommendation, 'highly_recommended');
  assert.ok(result.strongMatches.includes('Oracle Database'));
  assert.ok(result.strongMatches.includes('PL/SQL'));
  assert.equal(result.blockers.length, 0);
});

test('REGRESSION: a social-media role cannot outrank an engineering role', () => {
  // This exact posting scored 89% and ranked HIGHLY RECOMMENDED before the
  // relevance gate and shrinkage existed, purely because its description
  // mentioned reporting.
  const socialMedia = scoreJob(
    profile,
    job({
      title: 'Junior Community Manager*in/ Social Media (all genders)',
      description: 'You will own our social channels and handle reporting on campaign performance.',
      country: 'DE',
    }),
    { preferredCountries: COUNTRIES }
  );
  assert.equal(socialMedia.recommendation, 'low');
  assert.ok(socialMedia.overall <= 30, `expected a capped score, got ${socialMedia.overall}`);
  assert.ok(socialMedia.relevance.outOfScope);
  assert.ok(socialMedia.blockers.length > 0);

  const engineering = scoreJob(
    profile,
    job({
      title: 'Database Developer',
      description: 'Requirements:\n- Oracle, PL/SQL, SQL\n- 3+ years experience',
    }),
    { preferredCountries: COUNTRIES }
  );
  assert.ok(
    engineering.overall > socialMedia.overall + 30,
    `engineering ${engineering.overall} should clearly beat social media ${socialMedia.overall}`
  );
});

test('AI-tool experience never satisfies a machine-learning requirement', () => {
  // Spec §3: present AI-tool fluency honestly, never as ML engineering.
  const withAiTooling = CandidateProfile.parse({
    ...profile,
    skills: [
      ...profile.skills,
      {
        name: 'AI-assisted development',
        canonical: 'ai-assisted-dev',
        category: 'ai',
        years: 1,
        level: 'working',
        evidence: 'Confirmed by the candidate: uses AI coding assistants daily.',
      },
    ],
  });

  const result = scoreJob(
    withAiTooling,
    job({
      title: 'Machine Learning Engineer',
      description: 'Requirements:\n- Machine learning and deep learning\n- PyTorch\n- Python',
    }),
    { preferredCountries: COUNTRIES }
  );
  assert.ok(
    result.missingSkills.includes('Machine Learning'),
    `ML must be reported as missing, got missing=[${result.missingSkills.join(', ')}]`
  );
  assert.ok(result.components.aiTools.score <= 30, 'the AI component must not reward tool use here');
  assert.notEqual(result.recommendation, 'highly_recommended');
});

test('an explicit no-sponsorship posting is a blocker, not a small penalty', () => {
  const result = scoreJob(
    profile,
    job({
      title: 'Oracle PL/SQL Developer',
      description: [
        'Requirements:',
        '- Oracle, PL/SQL, SQL, performance tuning, data migration',
        'Please note we cannot sponsor visas for this role.',
      ].join('\n'),
      visaSponsorship: 'no',
    }),
    { preferredCountries: COUNTRIES }
  );
  assert.ok(profile.workAuthorisation.needsSponsorship, 'fixture assumes sponsorship is needed');
  assert.ok(result.blockers.some((b) => /sponsor/i.test(b)));
  assert.notEqual(result.recommendation, 'highly_recommended');
  assert.ok(result.components.location.score <= 10);
});

test('a hard local-language requirement blocks, English-friendly does not', () => {
  const german = scoreJob(
    profile,
    job({
      title: 'Datenbankentwickler',
      description: 'Requirements:\n- Oracle, PL/SQL\n- Fluent German is required (C1 level)',
      languages: ['German'],
    }),
    { preferredCountries: COUNTRIES }
  );
  assert.ok(german.blockers.some((b) => /German/.test(b)));

  const english = scoreJob(
    profile,
    job({
      title: 'Database Developer',
      description: 'Requirements:\n- Oracle, PL/SQL\n- Fluent English required',
      languages: ['English'],
    }),
    { preferredCountries: COUNTRIES }
  );
  assert.equal(english.components.language.score, 100);
  assert.ok(!english.blockers.some((b) => /English/.test(b)));
});

test('every component score stays within 0..100 across varied postings', () => {
  const samples = [
    job({ description: 'no requirements at all' }),
    job({ title: 'Nurse', description: 'caring role' }),
    job({ description: 'Requirements:\n- 20+ years of Oracle\n- PhD required', country: null, remote: 'remote' }),
    job({ description: 'Oracle PL/SQL SQL PostgreSQL Node.js Docker Kubernetes AWS', languages: ['German', 'French'] }),
  ];
  for (const sample of samples) {
    const result = scoreJob(profile, sample, { preferredCountries: COUNTRIES });
    assert.ok(result.overall >= 0 && result.overall <= 100, `overall ${result.overall}`);
    for (const [name, component] of Object.entries(result.components)) {
      assert.ok(
        component.score >= 0 && component.score <= 100,
        `${name} produced ${component.score} for "${sample.title}"`
      );
      assert.ok(component.reasons.length > 0, `${name} must explain itself`);
    }
  }
});

// --- truncated descriptions ----------------------------------------------

test('a snippet lowers confidence and does not assert missing skills', () => {
  const description = ['Requirements:', '- Oracle and PL/SQL', '- Kubernetes'].join('\n');

  const full = scoreJob(profile, job({ description, descriptionComplete: true }), {
    preferredCountries: COUNTRIES,
  });
  const snippet = scoreJob(profile, job({ description, descriptionComplete: false }), {
    preferredCountries: COUNTRIES,
  });

  assert.equal(full.confidence.level, 'high');
  assert.equal(snippet.confidence.level, 'low');
  assert.ok(snippet.confidence.reason);

  // Kubernetes is genuinely absent from the profile, so a full posting reports
  // it as a gap. A 500-character extract cannot support that claim.
  assert.ok(full.missingSkills.includes('Kubernetes'));
  assert.deepEqual(snippet.missingSkills, [], 'gaps must not be asserted from a snippet');

  // And a snippet must not score higher than the same text read in full.
  assert.ok(
    snippet.components.technical.score <= full.components.technical.score,
    `snippet ${snippet.components.technical.score} should not beat full ${full.components.technical.score}`
  );
  assert.ok(
    snippet.components.technical.reasons.some((r) => /500/.test(r)),
    'the truncation must be stated in the reasons the user sees'
  );
});

// --- language requirements -----------------------------------------------

test('REGRESSION: a German-language requirement written in German is detected', () => {
  // Verbatim from a real Arbeitnow posting. The English-only detector missed it
  // entirely, so the job scored 81% and was recommended to a candidate who does
  // not speak German. The abbreviation "mind." also broke sentence splitting,
  // separating the requirement from its "C1" level.
  const description = [
    'Deine Aufgaben:',
    '- Du baust unsere GTM-Systeme',
    'Dein Profil:',
    '- Du kommunizierst sicher auf Deutsch und Englisch (mind. C1)',
    '- Erfahrung mit SQL und Python',
    'Benefits:',
    '- Job Rad oder Deutschland Ticket: Waehle, ob du lieber dein Job Rad bezuschussen laesst.',
    '- Ueber EGYM Wellpass kannst du deutschlandweit Sportangebote nutzen.',
  ].join('\n');

  const languages = detectRequiredLanguages(description);
  assert.ok(languages.includes('German'), `German not detected: ${JSON.stringify(languages)}`);
  assert.ok(languages.includes('English'), `English not detected: ${JSON.stringify(languages)}`);

  // And it must now block, since the profile does not list German.
  const result = scoreJob(profile, job({ title: 'AI Go-to-Market Engineer', description, languages }), {
    preferredCountries: COUNTRIES,
  });
  assert.ok(result.blockers.some((b) => /German/.test(b)), `expected a German blocker, got ${JSON.stringify(result.blockers)}`);
  assert.notEqual(result.recommendation, 'highly_recommended');
});

test('a language merely mentioned in benefits is not a requirement', () => {
  // "Deutschland Ticket" and "deutschlandweit" appear in the benefits section of
  // almost every German posting. Treating those as a German requirement would
  // exclude the entire German market for an English-speaking candidate.
  const languages = detectRequiredLanguages(
    [
      'We work in English across the whole engineering team.',
      'Benefits: Deutschland Ticket, and deutschlandweit gym access.',
      'Our office team also speaks German informally.',
    ].join('\n')
  );
  assert.ok(!languages.includes('German'), `German wrongly treated as required: ${JSON.stringify(languages)}`);
});

test('abbreviations do not split a sentence apart', () => {
  const sentences = splitSentences('Du sprichst Deutsch (mind. C1). Und Englisch.');
  assert.ok(
    sentences.some((s) => /mind\. C1/.test(s)),
    `"mind. C1" was split: ${JSON.stringify(sentences)}`
  );
});
