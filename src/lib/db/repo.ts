import { getPool, withTransaction } from './pool.ts';
import type { NormalisedJob } from '../jobs/types.ts';
import type { MatchResult } from '../match/score.ts';
import type { CandidateProfile } from '../resume/profile.ts';

/**
 * Data access. Deliberately plain SQL rather than an ORM: the queries here are
 * few, the shapes are known, and an ORM would add a schema-definition language
 * on top of a schema that is already written and commented.
 */

export interface JobRow {
  id: number;
  source_slug: string;
  url: string;
  title: string;
  company: string;
  country: string | null;
  city: string | null;
  remote: string;
  employment_type: string | null;
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string | null;
  description: string;
  description_complete: boolean;
  languages: string[] | null;
  visa_sponsorship: string;
  relocation_support: string;
  posted_at: string | null;
  collected_at: string;
}

export interface MatchRow {
  overall: number;
  technical: number;
  experience: number;
  education: number;
  location: number;
  language: number;
  ai_tools: number;
  recommendation: string;
  breakdown: unknown;
  strong_matches: string[];
  partial_matches: string[];
  missing_skills: string[];
  confidence: string;
  blockers: string[];
  ai_summary: unknown;
}

export type JobWithMatch = JobRow & Partial<MatchRow> & { stage: string | null; notes: string | null };

/** The single user this personal tool serves. Created on first run. */
export async function ensureUser(email: string): Promise<number> {
  const { rows } = await getPool().query(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'local-only')
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [email]
  );
  return rows[0].id as number;
}

export async function saveProfile(userId: number, profile: CandidateProfile): Promise<number> {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO profiles (user_id, version, source_file, data, total_years)
            VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, version) DO UPDATE SET data = EXCLUDED.data, total_years = EXCLUDED.total_years
         RETURNING id`,
      [userId, profile.version, `profile.v${profile.version}.json`, JSON.stringify(profile), profile.totalYears]
    );
    const profileId = rows[0].id as number;

    // Rewritten wholesale rather than diffed: a profile version is immutable in
    // spirit, and a partial update could leave a skill whose evidence no longer
    // matches the profile it belongs to.
    await client.query('DELETE FROM profile_skills WHERE profile_id = $1', [profileId]);
    for (const skill of profile.skills) {
      await client.query(
        `INSERT INTO profile_skills (profile_id, skill, canonical, category, years, level, evidence)
              VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (profile_id, canonical) DO NOTHING`,
        [profileId, skill.name, skill.canonical, skill.category, skill.years, skill.level, skill.evidence]
      );
    }
    return profileId;
  });
}

export async function ensureSources(sources: { slug: string; displayName: string; requiresKey: boolean }[]) {
  for (const source of sources) {
    await getPool().query(
      `INSERT INTO job_sources (slug, display_name, requires_key) VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE SET display_name = EXCLUDED.display_name`,
      [source.slug, source.displayName, source.requiresKey]
    );
  }
}

export async function recordSourceRun(slug: string, status: string, error: string | null) {
  await getPool().query(
    `UPDATE job_sources SET last_run_at = now(), last_status = $2, last_error = $3 WHERE slug = $1`,
    [slug, status, error]
  );
}

/**
 * Upsert a collected job.
 *
 * On conflict the description is only replaced when the incoming copy is at
 * least as complete, so a truncated Adzuna snippet cannot overwrite a full
 * Arbeitnow posting on a later run.
 */
export async function upsertJob(job: NormalisedJob, contentHash: string): Promise<number> {
  const { rows } = await getPool().query(
    `INSERT INTO jobs (
        source_slug, source_job_id, url, title, company, country, city, remote,
        employment_type, salary_min, salary_max, salary_currency, description,
        description_complete, languages, visa_sponsorship, relocation_support,
        content_hash, raw, posted_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
     ON CONFLICT (source_slug, source_job_id) DO UPDATE SET
        title = EXCLUDED.title,
        url = EXCLUDED.url,
        description = CASE
          WHEN EXCLUDED.description_complete OR NOT jobs.description_complete
          THEN EXCLUDED.description ELSE jobs.description END,
        description_complete = jobs.description_complete OR EXCLUDED.description_complete,
        languages = EXCLUDED.languages,
        visa_sponsorship = EXCLUDED.visa_sponsorship,
        relocation_support = EXCLUDED.relocation_support,
        collected_at = now()
     RETURNING id`,
    [
      job.sourceSlug, job.sourceJobId, job.url, job.title, job.company, job.country, job.city, job.remote,
      job.employmentType, job.salaryMin, job.salaryMax, job.salaryCurrency, job.description,
      job.descriptionComplete, job.languages, job.visaSponsorship, job.relocationSupport,
      contentHash, JSON.stringify(job.raw ?? {}), job.postedAt,
    ]
  );
  return rows[0].id as number;
}

/** Mark later copies of the same posting as duplicates of the earliest one. */
export async function linkDuplicates(): Promise<number> {
  const { rowCount } = await getPool().query(
    `UPDATE jobs j SET duplicate_of = canonical.id
       FROM (
         SELECT content_hash, min(id) AS id FROM jobs GROUP BY content_hash
       ) canonical
      WHERE j.content_hash = canonical.content_hash
        AND j.id <> canonical.id
        AND j.duplicate_of IS DISTINCT FROM canonical.id`
  );
  return rowCount ?? 0;
}

export async function saveMatch(jobId: number, profileId: number, match: MatchResult) {
  await getPool().query(
    `INSERT INTO matches (
        job_id, profile_id, overall, technical, experience, education, location,
        language, ai_tools, recommendation, breakdown, strong_matches,
        partial_matches, missing_skills
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (job_id, profile_id) DO UPDATE SET
        overall = EXCLUDED.overall, technical = EXCLUDED.technical,
        experience = EXCLUDED.experience, education = EXCLUDED.education,
        location = EXCLUDED.location, language = EXCLUDED.language,
        ai_tools = EXCLUDED.ai_tools, recommendation = EXCLUDED.recommendation,
        breakdown = EXCLUDED.breakdown, strong_matches = EXCLUDED.strong_matches,
        partial_matches = EXCLUDED.partial_matches, missing_skills = EXCLUDED.missing_skills,
        scored_at = now()`,
    [
      jobId, profileId, match.overall, match.components.technical.score,
      match.components.experience.score, match.components.education.score,
      match.components.location.score, match.components.language.score,
      match.components.aiTools.score, match.recommendation,
      JSON.stringify({
        components: match.components,
        requirements: match.requirements,
        relevance: match.relevance,
        confidence: match.confidence,
        blockers: match.blockers,
      }),
      match.strongMatches, match.partialMatches, match.missingSkills,
    ]
  );
}

export async function saveAiSummary(jobId: number, profileId: number, summary: unknown, model: string) {
  await getPool().query(
    `UPDATE matches SET ai_summary = $3, ai_model = $4 WHERE job_id = $1 AND profile_id = $2`,
    [jobId, profileId, JSON.stringify(summary), model]
  );
}

export interface JobFilters {
  minScore?: number;
  countries?: string[];
  remote?: string;
  recommendation?: string;
  sponsorshipOnly?: boolean;
  search?: string;
  stage?: string;
  limit?: number;
  offset?: number;
}

/**
 * The main listing query.
 *
 * Duplicates are excluded, not merged in SQL: the canonical row already carries
 * the fullest description thanks to the upsert rule above.
 */
export async function listJobs(userId: number, filters: JobFilters = {}): Promise<{ rows: JobWithMatch[]; total: number }> {
  const where: string[] = ['j.duplicate_of IS NULL'];
  const params: unknown[] = [userId];

  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('$?', `$${params.length}`));
  };

  if (filters.minScore !== undefined) add('m.overall >= $?', filters.minScore);
  if (filters.countries?.length) add('j.country = ANY($?::text[])', filters.countries);
  if (filters.remote) add('j.remote = $?', filters.remote);
  if (filters.recommendation) add('m.recommendation = $?', filters.recommendation);
  if (filters.sponsorshipOnly) where.push("j.visa_sponsorship = 'yes'");
  if (filters.stage) add('a.stage = $?', filters.stage);
  if (filters.search) add('(j.title ILIKE $? OR j.company ILIKE $?)'.replace('$?', `$${params.length + 1}`), `%${filters.search}%`);

  const clause = `WHERE ${where.join(' AND ')}`;
  const limit = Math.min(filters.limit ?? 50, 200);
  const offset = filters.offset ?? 0;

  const sql = `
    SELECT j.*, m.overall, m.technical, m.experience, m.education, m.location,
           m.language, m.ai_tools, m.recommendation, m.breakdown,
           m.strong_matches, m.partial_matches, m.missing_skills, m.ai_summary,
           a.stage, a.notes
      FROM jobs j
      LEFT JOIN matches m ON m.job_id = j.id
      LEFT JOIN applications a ON a.job_id = j.id AND a.user_id = $1
      ${clause}
     ORDER BY m.overall DESC NULLS LAST, j.posted_at DESC NULLS LAST
     LIMIT ${limit} OFFSET ${offset}`;

  const countSql = `
    SELECT count(*)::int AS total
      FROM jobs j
      LEFT JOIN matches m ON m.job_id = j.id
      LEFT JOIN applications a ON a.job_id = j.id AND a.user_id = $1
      ${clause}`;

  const [list, count] = await Promise.all([
    getPool().query(sql, params),
    getPool().query(countSql, params),
  ]);
  return { rows: list.rows as JobWithMatch[], total: count.rows[0].total as number };
}

export async function getJob(userId: number, jobId: number): Promise<JobWithMatch | null> {
  const { rows } = await getPool().query(
    `SELECT j.*, m.overall, m.technical, m.experience, m.education, m.location,
            m.language, m.ai_tools, m.recommendation, m.breakdown,
            m.strong_matches, m.partial_matches, m.missing_skills, m.ai_summary, m.ai_model,
            a.stage, a.notes
       FROM jobs j
       LEFT JOIN matches m ON m.job_id = j.id
       LEFT JOIN applications a ON a.job_id = j.id AND a.user_id = $1
      WHERE j.id = $2`,
    [userId, jobId]
  );
  return (rows[0] as JobWithMatch) ?? null;
}

export const STAGES = [
  'new', 'shortlisted', 'resume_ready', 'applied', 'interview', 'offer', 'rejected', 'withdrawn',
] as const;
export type Stage = (typeof STAGES)[number];

/** Move a job through the tracker, recording the transition. */
export async function setStage(userId: number, jobId: number, stage: Stage, note?: string) {
  return withTransaction(async (client) => {
    const { rows: existing } = await client.query(
      'SELECT stage FROM applications WHERE user_id = $1 AND job_id = $2',
      [userId, jobId]
    );
    const from = existing[0]?.stage ?? null;

    const { rows } = await client.query(
      `INSERT INTO applications (user_id, job_id, stage, notes, applied_at)
            VALUES ($1, $2, $3, $4, CASE WHEN $3 = 'applied' THEN now() ELSE NULL END)
       ON CONFLICT (user_id, job_id) DO UPDATE SET
            stage = EXCLUDED.stage,
            notes = COALESCE(EXCLUDED.notes, applications.notes),
            applied_at = CASE
              WHEN EXCLUDED.stage = 'applied' AND applications.applied_at IS NULL THEN now()
              ELSE applications.applied_at END,
            updated_at = now()
         RETURNING id`,
      [userId, jobId, stage, note ?? null]
    );

    // Append-only history, so "when did this reach interview" is answerable.
    await client.query(
      'INSERT INTO application_events (application_id, from_stage, to_stage, note) VALUES ($1, $2, $3, $4)',
      [rows[0].id, from, stage, note ?? null]
    );
    return rows[0].id as number;
  });
}

export async function listApplications(userId: number) {
  const { rows } = await getPool().query(
    `SELECT a.id, a.stage, a.notes, a.applied_at, a.updated_at,
            j.id AS job_id, j.title, j.company, j.country, j.city, j.url, j.remote,
            m.overall, m.recommendation
       FROM applications a
       JOIN jobs j ON j.id = a.job_id
       LEFT JOIN matches m ON m.job_id = j.id
      WHERE a.user_id = $1
      ORDER BY a.updated_at DESC`,
    [userId]
  );
  return rows;
}

export interface DashboardStats {
  total_jobs: number;
  new_jobs: number;
  highly_matched: number;
  scored: number;
  duplicates: number;
  sponsoring: number;
  shortlisted: number;
  applied: number;
  interview: number;
  offer: number;
  rejected: number;
}

export async function dashboardStats(userId: number): Promise<DashboardStats> {
  const { rows } = await getPool().query(
    `SELECT
        (SELECT count(*)::int FROM jobs WHERE duplicate_of IS NULL) AS total_jobs,
        (SELECT count(*)::int FROM jobs WHERE duplicate_of IS NULL AND collected_at > now() - interval '24 hours') AS new_jobs,
        (SELECT count(*)::int FROM matches WHERE recommendation = 'highly_recommended') AS highly_matched,
        (SELECT count(*)::int FROM matches) AS scored,
        (SELECT count(*)::int FROM jobs WHERE duplicate_of IS NOT NULL) AS duplicates,
        (SELECT count(*)::int FROM jobs WHERE visa_sponsorship = 'yes') AS sponsoring,
        (SELECT count(*)::int FROM applications WHERE user_id = $1 AND stage = 'shortlisted') AS shortlisted,
        (SELECT count(*)::int FROM applications WHERE user_id = $1 AND stage = 'applied') AS applied,
        (SELECT count(*)::int FROM applications WHERE user_id = $1 AND stage = 'interview') AS interview,
        (SELECT count(*)::int FROM applications WHERE user_id = $1 AND stage = 'offer') AS offer,
        (SELECT count(*)::int FROM applications WHERE user_id = $1 AND stage = 'rejected') AS rejected`,
    [userId]
  );
  return rows[0] as DashboardStats;
}

export async function latestProfile(userId: number): Promise<{ id: number; data: CandidateProfile } | null> {
  const { rows } = await getPool().query(
    'SELECT id, data FROM profiles WHERE user_id = $1 ORDER BY version DESC LIMIT 1',
    [userId]
  );
  if (!rows[0]) return null;
  return { id: rows[0].id as number, data: rows[0].data as CandidateProfile };
}

export async function saveDocument(input: {
  userId: number;
  jobId: number;
  profileId: number;
  kind: 'resume' | 'cover_letter';
  tone: string | null;
  content: unknown;
  provenance: unknown;
  model: string;
}) {
  const { rows } = await getPool().query(
    `INSERT INTO documents (user_id, job_id, profile_id, kind, tone, content, provenance, ai_model)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      input.userId, input.jobId, input.profileId, input.kind, input.tone,
      JSON.stringify(input.content), JSON.stringify(input.provenance), input.model,
    ]
  );
  return rows[0].id as number;
}

export async function getDocument(userId: number, jobId: number, kind: 'resume' | 'cover_letter') {
  const { rows } = await getPool().query(
    `SELECT * FROM documents WHERE user_id = $1 AND job_id = $2 AND kind = $3
      ORDER BY created_at DESC LIMIT 1`,
    [userId, jobId, kind]
  );
  return rows[0] ?? null;
}
