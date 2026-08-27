-- ---------------------------------------------------------------------------
-- eurojob-assistant : migration 002
--   * real multi-user auth on the users/sessions tables that already existed
--   * per-user AI spend, so one user cannot spend another's daily allowance
--   * a role category on jobs, so the Jobs page can filter by kind of role
--   * global (not European-only) collection
--
-- Additive only. Nothing is dropped, deleted, or truncated: every statement is
-- CREATE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, or an UPDATE that fills a
-- newly added column. Re-running it is safe.
-- ---------------------------------------------------------------------------

-- --- auth -----------------------------------------------------------------

-- A display name for the header, and the flag that separates a real account
-- (has a bcrypt hash) from the pre-auth single-user row, whose password_hash
-- was the literal string 'local-only'. That row is kept and can be adopted by
-- setting a password: scripts/set-password.ts.
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

-- Sessions are looked up on every request, so the cookie's uuid is the primary
-- key already. What was missing is a cheap way to expire without deleting:
-- revoked_at is set instead of removing the row, which keeps the audit trail.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent text;
CREATE INDEX IF NOT EXISTS idx_sessions_live ON sessions (expires_at) WHERE revoked_at IS NULL;

-- Which profile file a user uploaded at signup, for their own reference.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS uploaded_filename text;

-- --- per-user AI spend ----------------------------------------------------

-- Spend used to live in data/ai-spend.json, which cannot work once there is
-- more than one user (they would share one allowance) or once the app runs on a
-- host with an ephemeral filesystem. One row per billed call, per user.
CREATE TABLE IF NOT EXISTS ai_spend (
    id       bigserial   PRIMARY KEY,
    user_id  bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    usd      numeric(12,6) NOT NULL,
    kind     text        NOT NULL,
    model    text        NOT NULL,
    at       timestamptz NOT NULL DEFAULT now()
);

-- The only query this table serves: "what has this user spent in the last 24
-- hours", asked before every single API call.
CREATE INDEX IF NOT EXISTS idx_ai_spend_user_at ON ai_spend (user_id, at DESC);

-- --- jobs: role category --------------------------------------------------

-- Derived in code (src/lib/match/roles.ts) from the title and requirements, and
-- stored so the Jobs page filter can offer exactly the categories the database
-- actually contains rather than a hardcoded list. NULL means "not yet
-- classified" -- distinct from 'other', which means "classified, and it fits
-- none of the named buckets".
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS role_category text;
CREATE INDEX IF NOT EXISTS idx_jobs_role_category ON jobs (role_category) WHERE duplicate_of IS NULL;

-- Country is now a filter rather than a collection restriction, so the listing
-- query groups by it constantly.
CREATE INDEX IF NOT EXISTS idx_jobs_country_canonical ON jobs (country) WHERE duplicate_of IS NULL;

-- --- matching -------------------------------------------------------------

-- Every match already carries the profile that produced it, which is what makes
-- per-user isolation possible without touching the jobs table: the listing joins
-- matches on the caller's own profile id. This index is what makes that join
-- cheap once there are several users' matches in the table.
CREATE INDEX IF NOT EXISTS idx_matches_profile_overall ON matches (profile_id, overall DESC);
CREATE INDEX IF NOT EXISTS idx_documents_user_job ON documents (user_id, job_id, kind, created_at DESC);
