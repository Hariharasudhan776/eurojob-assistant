import { getPool, withTransaction } from './pool.ts';
import type { NormalisedJob } from '../jobs/types.ts';
import type { MatchResult } from '../match/score.ts';
import { classifyRole } from '../match/roles.ts';
import { extractSkills } from '../match/taxonomy.ts';
import { staleClause } from '../jobs/lifecycle.ts';
import { parseLocation } from '../jobs/parse.ts';
import { geoCountry } from '../jobs/sources/jobicy.ts';
import type { CandidateProfile } from '../resume/profile.ts';

/**
 * Data access. Deliberately plain SQL rather than an ORM: the queries here are
 * few, the shapes are known, and an ORM would add a schema-definition language
 * on top of a schema that is already written and commented.
 *
 * ---------------------------------------------------------------------------
 * Multi-user isolation, and where the line sits
 * ---------------------------------------------------------------------------
 * `jobs` is SHARED. A posting is public data, and collecting the same job board
 * once per user would multiply the requests by the number of accounts for
 * identical results.
 *
 * Everything derived from a person is PRIVATE: matches (via `profile_id`),
 * applications, documents, notifications, and AI spend. Every query below that
 * touches a match joins it through MY_PROFILE -- a subquery for the caller's own
 * latest profile -- rather than on `job_id` alone. That is what makes isolation
 * structural instead of a filter someone can forget: there is no query shape
 * here that can return another user's score.
 */

/**
 * The caller's own latest profile. $1 is always the user id in the queries that
 * use this. Written as a subquery rather than a parameter so a caller cannot
 * pass someone else's profile id, by accident or otherwise.
 */
const MY_PROFILE = '(SELECT id FROM profiles WHERE user_id = $1 ORDER BY version DESC LIMIT 1)';

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
  /** From src/lib/match/roles.ts. NULL means never classified, not 'other'. */
  role_category: string | null;
  languages: string[] | null;
  visa_sponsorship: string;
  relocation_support: string;
  posted_at: string | null;
  collected_at: string;
  /** When a source last returned this posting. See src/lib/jobs/lifecycle.ts. */
  last_seen_at: string | null;
  /** NULL means open. Set, never deleted. */
  closed_at: string | null;
  /** 'expired' (date rule, self-reversing) or 'reported' (a human looked). */
  closed_reason: string | null;
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

/**
 * The CLI's user. `npm run sync` and `npm run db:migrate` have no session, so
 * they identify themselves with APP_USER_EMAIL and this creates the row if it is
 * missing. The hash is the literal 'local-only', which bcrypt can never verify,
 * so this route cannot be used to log in -- give the row a real password with
 * `npm run user:password` to adopt it as an account.
 */
export async function ensureUser(email: string): Promise<number> {
  const { rows } = await getPool().query(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'local-only')
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [email]
  );
  return rows[0].id as number;
}

// --- accounts and sessions -------------------------------------------------

export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  display_name: string | null;
  status: string;
  is_admin: boolean;
  ai_provider: string;
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const { rows } = await getPool().query(
    `SELECT id, email, password_hash, display_name, status, is_admin, ai_provider
       FROM users WHERE lower(email) = lower($1)`,
    [email]
  );
  return (rows[0] as UserRow) ?? null;
}

/** The AI provider this user's generations should use ('claude' | 'gemini'). */
export async function getAiProvider(userId: number): Promise<string> {
  const { rows } = await getPool().query('SELECT ai_provider FROM users WHERE id = $1', [userId]);
  return (rows[0]?.ai_provider as string) ?? 'claude';
}

export async function setAiProvider(userId: number, provider: 'claude' | 'gemini'): Promise<void> {
  await getPool().query('UPDATE users SET ai_provider = $2 WHERE id = $1', [userId, provider]);
}

export interface AdminUserRow {
  id: number;
  email: string;
  display_name: string | null;
  status: string;
  is_admin: boolean;
  ai_provider: string;
  created_at: string;
  last_login_at: string | null;
  has_password: boolean;
}

/** Every account, newest first — for the admin panel. */
export async function listAllUsers(): Promise<AdminUserRow[]> {
  const { rows } = await getPool().query(
    `SELECT id, email, display_name, status, is_admin, ai_provider, created_at, last_login_at,
            (password_hash IS NOT NULL AND password_hash <> 'local-only') AS has_password
       FROM users ORDER BY created_at DESC, id DESC`
  );
  return rows as AdminUserRow[];
}

export async function setUserStatus(userId: number, status: 'active' | 'pending' | 'rejected'): Promise<void> {
  await getPool().query('UPDATE users SET status = $2 WHERE id = $1', [userId, status]);
}

export async function setUserPasswordById(userId: number, passwordHash: string): Promise<void> {
  await getPool().query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, passwordHash]);
}

/** How many accounts are waiting for review — drives the admin nav badge. */
export async function pendingUserCount(): Promise<number> {
  const { rows } = await getPool().query(`SELECT count(*)::int AS n FROM users WHERE status = 'pending'`);
  return rows[0].n as number;
}

/** Make the named account an admin and mark it active. Used by the migration. */
export async function promoteToAdmin(email: string): Promise<void> {
  await getPool().query(
    `UPDATE users SET is_admin = true, status = 'active' WHERE lower(email) = lower($1)`,
    [email]
  );
}

/**
 * Create an account.
 *
 * Returns null when the email is taken. The pre-auth 'local-only' row is
 * adopted rather than rejected: the same email signing up gets its password set,
 * which keeps whatever profile and applications that row already owns instead of
 * orphaning them behind an account nobody can reach.
 */
/**
 * The CV text a user signed up with, if they signed up that way.
 *
 * Read only by the owner: the parameter is the user id from their own session,
 * never a value from a request body. A CV is an identity document -- name,
 * phone, address, employment history -- and one account being able to name
 * another's row id must not be enough to read it.
 */
export async function cvTextFor(userId: number): Promise<{ text: string; filename: string | null } | null> {
  const { rows } = await getPool().query(
    'SELECT cv_text, cv_filename FROM users WHERE id = $1 AND cv_text IS NOT NULL',
    [userId]
  );
  if (!rows[0]) return null;
  return { text: rows[0].cv_text as string, filename: (rows[0].cv_filename as string | null) ?? null };
}

/** Attach CV text to an account at signup. Never overwrites a saved profile. */
export async function saveCvText(userId: number, text: string, filename: string): Promise<void> {
  await getPool().query(
    'UPDATE users SET cv_text = $2, cv_filename = $3, cv_uploaded_at = now() WHERE id = $1',
    [userId, text, filename.slice(0, 200)]
  );
}

export async function createUser(email: string, passwordHash: string, displayName: string | null): Promise<number | null> {
  return withTransaction(async (client) => {
    // Locked while we decide, so two simultaneous signups for one address cannot
    // both conclude the row is free.
    const { rows: existing } = await client.query(
      'SELECT id, password_hash FROM users WHERE lower(email) = lower($1) FOR UPDATE',
      [email]
    );

    if (existing[0]) {
      // A real account already owns this address.
      if (existing[0].password_hash !== 'local-only') return null;
      await client.query(
        'UPDATE users SET password_hash = $2, display_name = COALESCE(display_name, $3) WHERE id = $1',
        [existing[0].id, passwordHash, displayName]
      );
      return existing[0].id as number;
    }

    try {
      // New accounts are created 'pending': they cannot sign in until an admin
      // approves them from the admin panel. (Existing rows kept their default
      // 'active' via the migration, so nobody already using the app is affected.)
      const { rows } = await client.query(
        `INSERT INTO users (email, password_hash, display_name, status)
         VALUES ($1, $2, $3, 'pending') RETURNING id`,
        [email.toLowerCase(), passwordHash, displayName]
      );
      return rows[0].id as number;
    } catch (err) {
      // 23505: the unique index caught a race the SELECT could not see.
      if ((err as { code?: string }).code === '23505') return null;
      throw err;
    }
  });
}

export async function setUserPassword(email: string, passwordHash: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    'UPDATE users SET password_hash = $2 WHERE lower(email) = lower($1)',
    [email, passwordHash]
  );
  return (rowCount ?? 0) > 0;
}

export async function touchLogin(userId: number): Promise<void> {
  await getPool().query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
}

export async function createSessionRow(userId: number, expiresAt: Date, userAgent: string | null): Promise<string> {
  const { rows } = await getPool().query(
    'INSERT INTO sessions (user_id, expires_at, user_agent) VALUES ($1, $2, $3) RETURNING id',
    [userId, expiresAt, userAgent?.slice(0, 300) ?? null]
  );
  return rows[0].id as string;
}

/** A session is live only if it exists, has not expired, and was not revoked. */
export async function liveSession(sessionId: string): Promise<{ user_id: number; email: string; display_name: string | null; is_admin: boolean } | null> {
  const { rows } = await getPool().query(
    `SELECT s.user_id, u.email, u.display_name, u.is_admin
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sessionId]
  );
  return rows[0] ?? null;
}

/**
 * Sign out. The row is marked revoked, never deleted -- "when did this session
 * end" stays answerable, and a deleted row cannot be distinguished from one that
 * never existed.
 */
export async function revokeSessionRow(sessionId: string): Promise<void> {
  await getPool().query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}

/** Everyone the scorer should score for: one row per user that has a profile. */
export async function usersWithProfiles(): Promise<{ user_id: number; email: string; profile_id: number }[]> {
  const { rows } = await getPool().query(
    `SELECT DISTINCT ON (u.id) u.id AS user_id, u.email, p.id AS profile_id
       FROM users u JOIN profiles p ON p.user_id = u.id
      ORDER BY u.id, p.version DESC`
  );
  return rows as { user_id: number; email: string; profile_id: number }[];
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
  // Classified here rather than in the collector so every write path -- sync,
  // backfill, a future source -- lands the same category for the same title.
  const roleCategory = classifyRole(job.title, extractSkills(job.description));

  const { rows } = await getPool().query(
    `INSERT INTO jobs (
        source_slug, source_job_id, url, title, company, country, city, remote,
        employment_type, salary_min, salary_max, salary_currency, description,
        description_complete, languages, visa_sponsorship, relocation_support,
        content_hash, raw, posted_at, role_category
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     ON CONFLICT (source_slug, source_job_id) DO UPDATE SET
        title = EXCLUDED.title,
        url = EXCLUDED.url,
        role_category = EXCLUDED.role_category,
        description = CASE
          WHEN EXCLUDED.description_complete OR NOT jobs.description_complete
          THEN EXCLUDED.description ELSE jobs.description END,
        description_complete = jobs.description_complete OR EXCLUDED.description_complete,
        languages = EXCLUDED.languages,
        -- COALESCE and not EXCLUDED: an improvement to the location parser
        -- should reach rows already stored, but a source that returns a job
        -- with no location this time must never erase the one it gave last
        -- time. Filling in is safe; overwriting with NULL is data loss.
        country = COALESCE(EXCLUDED.country, jobs.country),
        city = COALESCE(EXCLUDED.city, jobs.city),
        visa_sponsorship = EXCLUDED.visa_sponsorship,
        relocation_support = EXCLUDED.relocation_support,
        collected_at = now(),
        -- A source returning the posting is the strongest evidence available
        -- that it is still open, so record the sighting...
        last_seen_at = now(),
        -- ...and let it overturn an expiry, which is only ever a date rule.
        -- A 'reported' closure is NOT cleared: a human opened the posting and
        -- found it gone, and a source's index being slow to catch up does not
        -- outrank that.
        closed_at = CASE WHEN jobs.closed_reason = 'expired' THEN NULL ELSE jobs.closed_at END,
        closed_reason = CASE WHEN jobs.closed_reason = 'expired' THEN NULL ELSE jobs.closed_reason END
     RETURNING id`,
    [
      job.sourceSlug, job.sourceJobId, job.url, job.title, job.company, job.country, job.city, job.remote,
      job.employmentType, job.salaryMin, job.salaryMax, job.salaryCurrency, job.description,
      job.descriptionComplete, job.languages, job.visaSponsorship, job.relocationSupport,
      contentHash, JSON.stringify(job.raw ?? {}), job.postedAt, roleCategory,
    ]
  );
  return rows[0].id as number;
}

/**
 * Place postings whose country the parser could not read when they were stored.
 *
 * This exists because a fix to `parseLocation` does not reach the database on
 * its own. Collection parses the location once, at collection time, and the
 * upsert has no reason to revisit a field that does not change -- so 592
 * Arbeitnow rows sat with `country = NULL` through a parser change that placed
 * two thirds of them. They were invisible to the country filter and scored as
 * "location unknown" against a candidate whose whole target list is countries.
 *
 * The same shape as `backfillRoleCategories`: read-only until it has an answer,
 * updates nothing it cannot improve, and returns what changed. It never clears a
 * country that is already set -- an unreadable location is left NULL, because a
 * refused guess is the behaviour `parseLocation` is built around.
 *
 * The location lives in a different place in each source's payload, which is why
 * the three are named here rather than inferred: `raw.location` (Arbeitnow, a
 * string), `raw.jobGeo` (Jobicy, an eligibility list -- see geoCountry), and
 * `raw.locations[].name` (The Muse, an array of place names). Adzuna states its
 * country in the request, never in the payload, so its rows are never NULL and
 * there is nothing here to do for them.
 */
export async function backfillCountries(): Promise<{ scanned: number; placed: number }> {
  const { rows } = await getPool().query(
    `SELECT id, source_slug, raw FROM jobs WHERE country IS NULL`
  );

  let placed = 0;
  for (const row of rows as { id: number; source_slug: string; raw: Record<string, unknown> }[]) {
    const raw = row.raw ?? {};

    let country: string | null = null;
    let city: string | null = null;

    if (typeof raw.location === 'string') {
      ({ country, city } = parseLocation(raw.location));
    } else if (typeof raw.jobGeo === 'string') {
      // Remote eligibility, so a region ("EMEA", "Anywhere") stays NULL and
      // there is no city to record.
      country = geoCountry(raw.jobGeo);
    } else if (Array.isArray(raw.locations)) {
      const named = (raw.locations as { name?: string }[])
        .map((l) => l?.name?.trim())
        .filter((n): n is string => Boolean(n));
      for (const name of named) {
        ({ country, city } = parseLocation(name));
        if (country) break;
      }
    }

    if (!country) continue;
    await getPool().query('UPDATE jobs SET country = $2, city = COALESCE(city, $3) WHERE id = $1', [
      row.id,
      country,
      city,
    ]);
    placed += 1;
  }

  return { scanned: rows.length, placed };
}

/**
 * Close postings that nothing has listed for longer than a posting stays open,
 * and reopen any that a sweep has since returned.
 *
 * Run after collection, so a job seen in this run is never closed by it. Both
 * directions matter: the reopen half is what makes the rule safe to be wrong
 * about, because the next sweep that returns the posting undoes the mistake by
 * itself. Nothing is deleted -- a closed job keeps its row, its matches, its
 * generated documents and its application history.
 *
 * 'reported' closures are untouched in both directions. See lifecycle.ts.
 */
export async function sweepClosedJobs(): Promise<{ closed: number; reopened: number }> {
  const closed = await getPool().query(
    `UPDATE jobs j SET closed_at = now(), closed_reason = 'expired'
      WHERE j.closed_at IS NULL AND ${staleClause('j')}`
  );
  const reopened = await getPool().query(
    `UPDATE jobs j SET closed_at = NULL, closed_reason = NULL
      WHERE j.closed_reason = 'expired' AND NOT (${staleClause('j')})`
  );
  return { closed: closed.rowCount ?? 0, reopened: reopened.rowCount ?? 0 };
}

/**
 * A human opened the posting and found it gone.
 *
 * The only closure signal with certainty behind it, and therefore the only one
 * a later sweep does not overturn. Jobs are shared rows (§4), so one person
 * reporting a dead posting spares everyone else the click -- the same reasoning
 * that makes a collected job public data in the first place.
 */
export async function reportJobGone(jobId: number): Promise<void> {
  await getPool().query(
    `UPDATE jobs SET closed_at = now(), closed_reason = 'reported' WHERE id = $1 AND closed_at IS NULL`,
    [jobId]
  );
}

/** Undo a report. Nothing here is one-way. */
export async function reopenJob(jobId: number): Promise<void> {
  await getPool().query('UPDATE jobs SET closed_at = NULL, closed_reason = NULL WHERE id = $1', [jobId]);
}

/**
 * Fill in `role_category` for jobs collected before the column existed, and for
 * anything a classifier change would now label differently.
 *
 * Reads and updates only -- no row is removed. Returns how many changed.
 */
export async function backfillRoleCategories(): Promise<{ scanned: number; updated: number }> {
  const { rows } = await getPool().query('SELECT id, title, description, role_category FROM jobs');
  let updated = 0;
  for (const row of rows as { id: number; title: string; description: string; role_category: string | null }[]) {
    const category = classifyRole(row.title, extractSkills(row.description));
    if (category === row.role_category) continue;
    await getPool().query('UPDATE jobs SET role_category = $2 WHERE id = $1', [row.id, category]);
    updated += 1;
  }
  return { scanned: rows.length, updated };
}

/**
 * The role categories and countries actually present in the feed, for the Jobs
 * page filters. Built from the data rather than from a constant, so a filter can
 * never offer a value that returns nothing, or omit one that would.
 */
export async function facetCounts(): Promise<{
  roles: { value: string | null; count: number }[];
  countries: { value: string | null; count: number }[];
}> {
  const [roles, countries] = await Promise.all([
    getPool().query(
      `SELECT role_category AS value, count(*)::int AS count
         FROM jobs WHERE duplicate_of IS NULL AND closed_at IS NULL
        GROUP BY role_category ORDER BY count DESC`
    ),
    getPool().query(
      `SELECT country AS value, count(*)::int AS count
         FROM jobs WHERE duplicate_of IS NULL AND closed_at IS NULL
        GROUP BY country ORDER BY count DESC`
    ),
  ]);
  return {
    roles: roles.rows as { value: string | null; count: number }[],
    countries: countries.rows as { value: string | null; count: number }[],
  };
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

/**
 * Save many matches in one statement.
 *
 * Scoring is free, so a new user's profile has to be scored against everything
 * already collected -- several hundred rows. One INSERT per row is several
 * hundred round trips, which is tolerable against loopback and far too slow
 * against a managed database in another data centre.
 */
export async function saveMatches(profileId: number, entries: { jobId: number; match: MatchResult }[]): Promise<number> {
  if (entries.length === 0) return 0;

  const COLUMNS = 14;
  const values: unknown[] = [];
  const tuples: string[] = [];

  for (const [index, entry] of entries.entries()) {
    const base = index * COLUMNS;
    tuples.push(`(${Array.from({ length: COLUMNS }, (_, i) => `$${base + i + 1}`).join(',')})`);
    const m = entry.match;
    values.push(
      entry.jobId, profileId, m.overall, m.components.technical.score,
      m.components.experience.score, m.components.education.score,
      m.components.location.score, m.components.language.score,
      m.components.aiTools.score, m.recommendation,
      JSON.stringify({
        components: m.components,
        requirements: m.requirements,
        relevance: m.relevance,
        confidence: m.confidence,
        blockers: m.blockers,
      }),
      m.strongMatches, m.partialMatches, m.missingSkills
    );
  }

  const { rowCount } = await getPool().query(
    `INSERT INTO matches (
        job_id, profile_id, overall, technical, experience, education, location,
        language, ai_tools, recommendation, breakdown, strong_matches,
        partial_matches, missing_skills
     ) VALUES ${tuples.join(',')}
     ON CONFLICT (job_id, profile_id) DO UPDATE SET
        overall = EXCLUDED.overall, technical = EXCLUDED.technical,
        experience = EXCLUDED.experience, education = EXCLUDED.education,
        location = EXCLUDED.location, language = EXCLUDED.language,
        ai_tools = EXCLUDED.ai_tools, recommendation = EXCLUDED.recommendation,
        breakdown = EXCLUDED.breakdown, strong_matches = EXCLUDED.strong_matches,
        partial_matches = EXCLUDED.partial_matches, missing_skills = EXCLUDED.missing_skills,
        scored_at = now()`,
    values
  );
  return rowCount ?? 0;
}

/**
 * Jobs this profile has never been scored against, newest first, plus how many
 * are left. Used to catch a new account up with the feed a batch at a time --
 * a request that has to finish inside a serverless timeout cannot score 5,000
 * postings in one go, and pretending otherwise would fail silently.
 */
export async function unscoredJobs(profileId: number, limit: number): Promise<{ rows: JobRow[]; remaining: number }> {
  const [batch, count] = await Promise.all([
    getPool().query(
      `SELECT j.* FROM jobs j
        WHERE j.duplicate_of IS NULL
          AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.job_id = j.id AND m.profile_id = $1)
        ORDER BY j.posted_at DESC NULLS LAST, j.id DESC
        LIMIT $2`,
      [profileId, Math.max(1, Math.min(limit, 2000))]
    ),
    getPool().query(
      `SELECT count(*)::int AS remaining FROM jobs j
        WHERE j.duplicate_of IS NULL
          AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.job_id = j.id AND m.profile_id = $1)`,
      [profileId]
    ),
  ]);
  return { rows: batch.rows as JobRow[], remaining: count.rows[0].remaining as number };
}

/** Every canonical job, in pages, for a full re-score after a profile change. */
export async function allJobs(limit: number, afterId = 0): Promise<JobRow[]> {
  const { rows } = await getPool().query(
    `SELECT * FROM jobs WHERE duplicate_of IS NULL AND id > $2 ORDER BY id LIMIT $1`,
    [Math.max(1, Math.min(limit, 2000)), afterId]
  );
  return rows as JobRow[];
}

// --- per-user search preferences -------------------------------------------

/**
 * Which countries this person is actually targeting.
 *
 * Collection is global now, but the location component of the score is not:
 * "in one of your target countries" only means something if the target list is
 * that user's, not a global list of everywhere the collector reaches. Stored in
 * the `search_preferences` table, which has been in the schema since the start.
 */
export async function getTargetCountries(userId: number): Promise<string[]> {
  const { rows } = await getPool().query('SELECT countries FROM search_preferences WHERE user_id = $1', [userId]);
  const countries = (rows[0]?.countries as string[] | undefined) ?? [];
  return countries.filter((c) => typeof c === 'string' && c.length === 2);
}

export async function setTargetCountries(userId: number, countries: string[]): Promise<void> {
  const clean = [...new Set(countries.map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)))];
  await getPool().query(
    `INSERT INTO search_preferences (user_id, countries) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET countries = EXCLUDED.countries, updated_at = now()`,
    [userId, clean]
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
  /** A role_category value from src/lib/match/roles.ts. */
  role?: string;
  search?: string;
  stage?: string;
  /**
   * Show jobs the caller has already acted on. Off by default: once an
   * application is sent (or closed), the job's home is the Applications
   * tracker, and leaving it in the discovery list means re-reading postings
   * that are already decided. Filtering by an explicit `stage` implies it.
   */
  includeActioned?: boolean;
  /**
   * Show postings judged no longer open. Off by default, for the same reason
   * `includeActioned` is: a filled or expired role is not a candidate, and
   * leaving it in the list is the complaint this flag exists to answer. Nothing
   * is deleted, so switching this on brings every one of them back.
   */
  includeClosed?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Stages after which a job leaves the discovery surfaces (jobs list, top
 * matches). Pre-application stages -- new, shortlisted, resume_ready -- keep the
 * job visible: the person is still deciding.
 */
export const ACTIONED_STAGES = ['applied', 'interview', 'offer', 'rejected', 'withdrawn'] as const;
const ACTIONED_SQL = ACTIONED_STAGES.map((s) => `'${s}'`).join(', ');

/**
 * The main listing query.
 *
 * Duplicates are excluded, not merged in SQL: the canonical row already carries
 * the fullest description thanks to the upsert rule above.
 *
 * The match join is scoped to the caller's own profile (MY_PROFILE). Joining on
 * `job_id` alone would show whoever's score happened to be written last, which
 * with several users is both wrong and a leak.
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
  if (filters.role) add('j.role_category = $?', filters.role);
  if (filters.stage) add('a.stage = $?', filters.stage);
  if (filters.search) add('(j.title ILIKE $? OR j.company ILIKE $?)'.replace('$?', `$${params.length + 1}`), `%${filters.search}%`);
  // Applied, rejected and the stages beyond them live in the tracker, not here.
  if (!filters.stage && !filters.includeActioned) {
    where.push(`(a.stage IS NULL OR a.stage NOT IN (${ACTIONED_SQL}))`);
  }
  // Postings that are no longer open. Filtered, never deleted.
  if (!filters.includeClosed) where.push('j.closed_at IS NULL');

  const clause = `WHERE ${where.join(' AND ')}`;
  const limit = Math.min(filters.limit ?? 50, 200);
  const offset = filters.offset ?? 0;
  const joins = `
      LEFT JOIN matches m ON m.job_id = j.id AND m.profile_id = ${MY_PROFILE}
      LEFT JOIN applications a ON a.job_id = j.id AND a.user_id = $1`;

  const sql = `
    SELECT j.*, m.overall, m.technical, m.experience, m.education, m.location,
           m.language, m.ai_tools, m.recommendation, m.breakdown,
           m.strong_matches, m.partial_matches, m.missing_skills, m.ai_summary,
           a.stage, a.notes
      FROM jobs j
      ${joins}
      ${clause}
     ORDER BY m.overall DESC NULLS LAST, j.posted_at DESC NULLS LAST
     LIMIT ${limit} OFFSET ${offset}`;

  const countSql = `
    SELECT count(*)::int AS total
      FROM jobs j
      ${joins}
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
       LEFT JOIN matches m ON m.job_id = j.id AND m.profile_id = ${MY_PROFILE}
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
            j.role_category, m.overall, m.recommendation
       FROM applications a
       JOIN jobs j ON j.id = a.job_id
       LEFT JOIN matches m ON m.job_id = j.id AND m.profile_id = ${MY_PROFILE}
      WHERE a.user_id = $1
      ORDER BY a.updated_at DESC`,
    [userId]
  );
  return rows;
}

/**
 * The agent's output channel. One row per (user, job), written when a job first
 * becomes a top match for that person, so a notification can never repeat --
 * the NOT EXISTS on notifications is the dedup, not a timestamp comparison,
 * which would re-notify after any re-score.
 *
 * Jobs the person has already acted on are excluded for the same reason they
 * left the jobs list: there is no news in a posting whose outcome is decided.
 */
export async function notifyNewTopMatches(userId: number): Promise<{ job_id: number; title: string }[]> {
  const { rows } = await getPool().query(
    `INSERT INTO notifications (user_id, job_id, title, body)
     SELECT $1, j.id,
            'New top match: ' || j.title || ' — ' || j.company,
            m.overall || '% match · ' || coalesce(j.country, 'location not stated')
              || CASE WHEN j.visa_sponsorship = 'yes' THEN ' · sponsorship stated' ELSE '' END
       FROM matches m
       JOIN jobs j ON j.id = m.job_id
      WHERE m.profile_id = ${MY_PROFILE}
        AND j.duplicate_of IS NULL
        AND m.recommendation = 'highly_recommended'
        AND j.closed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.user_id = $1 AND n.job_id = j.id)
        AND NOT EXISTS (SELECT 1 FROM applications a
                         WHERE a.user_id = $1 AND a.job_id = j.id
                           AND a.stage IN (${ACTIONED_SQL}))
     RETURNING job_id, title`,
    [userId]
  );
  return rows as { job_id: number; title: string }[];
}

export interface NotificationRow {
  id: number;
  job_id: number | null;
  title: string;
  body: string;
  created_at: string;
}

export async function unreadNotifications(userId: number, limit = 20): Promise<NotificationRow[]> {
  const { rows } = await getPool().query(
    `SELECT id, job_id, title, body, created_at
       FROM notifications
      WHERE user_id = $1 AND read_at IS NULL
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId, limit]
  );
  return rows as NotificationRow[];
}

export async function markNotificationsRead(userId: number): Promise<number> {
  const { rowCount } = await getPool().query(
    'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL',
    [userId]
  );
  return rowCount ?? 0;
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

/**
 * Dashboard counters.
 *
 * The job counts are of the shared feed -- postings are public and collected
 * once. Everything derived from this person (their scores, their pipeline) is
 * scoped to them: `matches` is filtered by their own profile, not counted across
 * every user's matches, which is what made the pre-auth version's numbers
 * meaningless as soon as a second account existed.
 */
export async function dashboardStats(userId: number): Promise<DashboardStats> {
  const { rows } = await getPool().query(
    `SELECT
        (SELECT count(*)::int FROM jobs WHERE duplicate_of IS NULL AND closed_at IS NULL) AS total_jobs,
        (SELECT count(*)::int FROM jobs WHERE duplicate_of IS NULL AND closed_at IS NULL AND collected_at > now() - interval '24 hours') AS new_jobs,
        (SELECT count(*)::int FROM matches m JOIN jobs j ON j.id = m.job_id
          WHERE j.duplicate_of IS NULL AND m.profile_id = ${MY_PROFILE}
            AND m.recommendation = 'highly_recommended'
            AND j.closed_at IS NULL
            -- Counts what the "Top matches" link will actually show: a job
            -- already applied to, or no longer open, has left the discovery list.
            AND NOT EXISTS (SELECT 1 FROM applications a
                             WHERE a.user_id = $1 AND a.job_id = j.id
                               AND a.stage IN (${ACTIONED_SQL}))) AS highly_matched,
        (SELECT count(*)::int FROM matches WHERE profile_id = ${MY_PROFILE}) AS scored,
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

/**
 * Score distribution for the caller's own matches, bucketed for the dashboard
 * histogram. Joins through MY_PROFILE like every other match query, so it can
 * only ever see this user's scores.
 */
export async function scoreBuckets(userId: number): Promise<{ label: string; value: number }[]> {
  const { rows } = await getPool().query(
    `SELECT
        count(*) FILTER (WHERE m.overall >= 80)::int AS b80,
        count(*) FILTER (WHERE m.overall >= 70 AND m.overall < 80)::int AS b70,
        count(*) FILTER (WHERE m.overall >= 60 AND m.overall < 70)::int AS b60,
        count(*) FILTER (WHERE m.overall >= 50 AND m.overall < 60)::int AS b50,
        count(*) FILTER (WHERE m.overall < 50)::int AS b0
       FROM matches m JOIN jobs j ON j.id = m.job_id
      WHERE j.duplicate_of IS NULL AND m.profile_id = ${MY_PROFILE}`,
    [userId]
  );
  const r = rows[0];
  return [
    { label: '80+', value: r.b80 },
    { label: '70–79', value: r.b70 },
    { label: '60–69', value: r.b60 },
    { label: '50–59', value: r.b50 },
    { label: '<50', value: r.b0 },
  ];
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

// --- per-user AI spend ------------------------------------------------------

/**
 * Spend is recorded per user, because a shared allowance is not an allowance.
 * With one JSON file for the whole instance, the first person to run a few
 * resume generations would spend everyone else's day.
 *
 * The read is a single aggregate over a covering index, because it runs before
 * every API call -- see BudgetGuard.
 */
export async function recordSpend(userId: number, usd: number, kind: string, model: string): Promise<void> {
  await getPool().query('INSERT INTO ai_spend (user_id, usd, kind, model) VALUES ($1, $2, $3, $4)', [
    userId, usd, kind, model,
  ]);
}

export async function spentLast24h(userId: number): Promise<number> {
  const { rows } = await getPool().query(
    `SELECT COALESCE(sum(usd), 0)::float8 AS total
       FROM ai_spend WHERE user_id = $1 AND at > now() - interval '24 hours'`,
    [userId]
  );
  return Number(rows[0]?.total ?? 0);
}

export async function spendBreakdown(userId: number): Promise<{ kind: string; calls: number; usd: number }[]> {
  const { rows } = await getPool().query(
    `SELECT kind, count(*)::int AS calls, sum(usd)::float8 AS usd
       FROM ai_spend WHERE user_id = $1 AND at > now() - interval '24 hours'
      GROUP BY kind ORDER BY usd DESC`,
    [userId]
  );
  return rows as { kind: string; calls: number; usd: number }[];
}

// --- content-addressed AI cache, shared across users -----------------------

/**
 * The cache is keyed by content hash, so two users looking at the same posting
 * with the same profile version would share an answer. In practice the key
 * includes the profile version, and profiles differ per person, so entries are
 * effectively private anyway -- but the sharing is deliberate and safe: a cache
 * hit can only ever return the answer to an identical question.
 *
 * This exists because a deployed instance has no writable disk. `ai_cache` was
 * already in the schema for exactly this.
 */
export async function cacheGet(kind: string, key: string, model: string): Promise<unknown | null> {
  const { rows } = await getPool().query(
    'SELECT response FROM ai_cache WHERE kind = $1 AND cache_key = $2 AND model = $3',
    [kind, key, model]
  );
  return rows[0]?.response ?? null;
}

export async function cacheSet(
  kind: string,
  key: string,
  model: string,
  value: unknown,
  usage: { inputTokens: number; outputTokens: number }
): Promise<void> {
  await getPool().query(
    `INSERT INTO ai_cache (kind, cache_key, model, response, input_tokens, output_tokens)
          VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (kind, cache_key, model) DO UPDATE SET response = EXCLUDED.response`,
    [kind, key, model, JSON.stringify(value), usage.inputTokens, usage.outputTokens]
  );
}
