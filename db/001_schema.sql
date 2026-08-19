-- ---------------------------------------------------------------------------
-- eurojob-assistant : schema
--
-- Design notes that matter later:
--
--  * Jobs are stored RAW from the source and normalised separately. When a
--    parser turns out to be wrong, the raw payload is still there to re-parse
--    instead of having to re-crawl.
--  * `content_hash` on jobs is the deduplication and AI-cache key. An analysis
--    is cached against (content_hash, profile_version, model) so re-running the
--    matcher never re-sends a job description the AI has already seen.
--  * The candidate profile is VERSIONED. Every match records which profile
--    version produced it, so a score is always explainable against the exact
--    facts that were true at the time.
--  * Nothing in this schema stores an invented fact: every profile row traces
--    to a resume section, and `evidence` on skills records where it came from.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- --- auth -----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
    id            bigserial PRIMARY KEY,
    email         text        NOT NULL UNIQUE,
    password_hash text        NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

-- --- candidate profile ----------------------------------------------------

-- One row per version. Never updated in place: a new parse creates a new
-- version so historical matches stay reproducible.
CREATE TABLE IF NOT EXISTS profiles (
    id             bigserial PRIMARY KEY,
    user_id        bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    version        integer     NOT NULL,
    source_file    text,
    -- The full structured profile. Kept as jsonb so the shape can evolve
    -- without a migration per field, and validated by zod on the way in.
    data           jsonb       NOT NULL,
    total_years    numeric(4,1),
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, version)
);

-- Skills are also relational, because matching needs to join and aggregate
-- them, and `evidence` is what keeps the app honest about where each came from.
CREATE TABLE IF NOT EXISTS profile_skills (
    id         bigserial PRIMARY KEY,
    profile_id bigint  NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    skill      text    NOT NULL,
    canonical  text    NOT NULL,
    category   text    NOT NULL,
    years      numeric(4,1),
    level      text    NOT NULL CHECK (level IN ('expert', 'strong', 'working', 'familiar')),
    evidence   text    NOT NULL,
    UNIQUE (profile_id, canonical)
);

CREATE INDEX IF NOT EXISTS idx_profile_skills_canonical ON profile_skills (canonical);

-- --- search preferences ---------------------------------------------------

CREATE TABLE IF NOT EXISTS search_preferences (
    user_id              bigint PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    countries            text[]  NOT NULL DEFAULT '{}',
    cities               text[]  NOT NULL DEFAULT '{}',
    titles               text[]  NOT NULL DEFAULT '{}',
    technologies         text[]  NOT NULL DEFAULT '{}',
    excluded_keywords    text[]  NOT NULL DEFAULT '{}',
    min_salary_eur       integer,
    remote_preference    text    NOT NULL DEFAULT 'any' CHECK (remote_preference IN ('any', 'remote', 'hybrid', 'onsite')),
    experience_level     text,
    requires_sponsorship boolean NOT NULL DEFAULT true,
    english_only         boolean NOT NULL DEFAULT true,
    relocation_only      boolean NOT NULL DEFAULT false,
    employment_types     text[]  NOT NULL DEFAULT '{}',
    notify_threshold     integer NOT NULL DEFAULT 80 CHECK (notify_threshold BETWEEN 0 AND 100),
    updated_at           timestamptz NOT NULL DEFAULT now()
);

-- --- jobs -----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS job_sources (
    id            bigserial PRIMARY KEY,
    slug          text        NOT NULL UNIQUE,
    display_name  text        NOT NULL,
    requires_key  boolean     NOT NULL DEFAULT false,
    enabled       boolean     NOT NULL DEFAULT true,
    last_run_at   timestamptz,
    last_status   text,
    last_error    text
);

CREATE TABLE IF NOT EXISTS jobs (
    id                bigserial PRIMARY KEY,
    source_slug       text        NOT NULL REFERENCES job_sources (slug),
    source_job_id     text        NOT NULL,
    url               text        NOT NULL,
    title             text        NOT NULL,
    company           text        NOT NULL,
    country           text,
    city              text,
    remote            text        CHECK (remote IN ('remote', 'hybrid', 'onsite', 'unknown')),
    employment_type   text,
    salary_min        integer,
    salary_max        integer,
    salary_currency   text,
    description       text        NOT NULL,
    -- Parsed requirements. NULL means "not yet parsed"; an empty array means
    -- "parsed, and the posting genuinely did not say". Those are different
    -- facts and the UI must not conflate them.
    required_skills   text[],
    preferred_skills  text[],
    min_years         numeric(4,1),
    education         text,
    languages         text[],
    -- 'yes' / 'no' / 'not_specified'. Never inferred -- see §14 of the spec:
    -- absence of a statement is not a denial, and not a promise either.
    visa_sponsorship  text        NOT NULL DEFAULT 'not_specified'
                                  CHECK (visa_sponsorship IN ('yes', 'no', 'not_specified')),
    relocation_support text       NOT NULL DEFAULT 'not_specified'
                                  CHECK (relocation_support IN ('yes', 'no', 'not_specified')),
    content_hash      text        NOT NULL,
    duplicate_of      bigint      REFERENCES jobs (id),
    raw               jsonb       NOT NULL,
    posted_at         timestamptz,
    collected_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (source_slug, source_job_id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_content_hash ON jobs (content_hash);
CREATE INDEX IF NOT EXISTS idx_jobs_country      ON jobs (country);
CREATE INDEX IF NOT EXISTS idx_jobs_posted       ON jobs (posted_at DESC);
-- Partial: the canonical (non-duplicate) jobs are what every listing query
-- filters to, and they are the minority-case index worth having.
CREATE INDEX IF NOT EXISTS idx_jobs_canonical    ON jobs (id) WHERE duplicate_of IS NULL;

-- --- matching -------------------------------------------------------------

CREATE TABLE IF NOT EXISTS matches (
    id              bigserial PRIMARY KEY,
    job_id          bigint  NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    profile_id      bigint  NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    overall         integer NOT NULL CHECK (overall BETWEEN 0 AND 100),
    technical       integer NOT NULL CHECK (technical BETWEEN 0 AND 100),
    experience      integer NOT NULL CHECK (experience BETWEEN 0 AND 100),
    education       integer NOT NULL CHECK (education BETWEEN 0 AND 100),
    location        integer NOT NULL CHECK (location BETWEEN 0 AND 100),
    language        integer NOT NULL CHECK (language BETWEEN 0 AND 100),
    ai_tools        integer NOT NULL CHECK (ai_tools BETWEEN 0 AND 100),
    recommendation  text    NOT NULL CHECK (recommendation IN ('highly_recommended', 'possible', 'low')),
    -- Every component score carries the facts that produced it, so a number is
    -- always defensible rather than arbitrary (spec section 6).
    breakdown       jsonb   NOT NULL,
    strong_matches  text[]  NOT NULL DEFAULT '{}',
    partial_matches text[]  NOT NULL DEFAULT '{}',
    missing_skills  text[]  NOT NULL DEFAULT '{}',
    -- Populated only when the LLM narration step runs. A match is fully usable
    -- without it: scoring is deterministic, the AI only explains.
    ai_summary      text,
    ai_model        text,
    scored_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (job_id, profile_id)
);

CREATE INDEX IF NOT EXISTS idx_matches_overall ON matches (overall DESC);

-- AI response cache, keyed by content rather than by job id, so the same
-- posting arriving from a second source costs nothing (spec section 19).
CREATE TABLE IF NOT EXISTS ai_cache (
    id           bigserial PRIMARY KEY,
    kind         text        NOT NULL,
    cache_key    text        NOT NULL,
    model        text        NOT NULL,
    response     jsonb       NOT NULL,
    input_tokens integer,
    output_tokens integer,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (kind, cache_key, model)
);

-- --- applications ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS applications (
    id           bigserial PRIMARY KEY,
    user_id      bigint  NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    job_id       bigint  NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
    stage        text    NOT NULL DEFAULT 'new'
                         CHECK (stage IN ('new', 'shortlisted', 'resume_ready', 'applied',
                                          'interview', 'offer', 'rejected', 'withdrawn')),
    notes        text,
    applied_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, job_id)
);

CREATE INDEX IF NOT EXISTS idx_applications_stage ON applications (user_id, stage);

-- Stage history is append-only: "when did this move to interview" is a
-- question the tracker should always be able to answer.
CREATE TABLE IF NOT EXISTS application_events (
    id             bigserial PRIMARY KEY,
    application_id bigint      NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
    from_stage     text,
    to_stage       text        NOT NULL,
    note           text,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_application_events_app ON application_events (application_id);

-- --- generated documents --------------------------------------------------

CREATE TABLE IF NOT EXISTS documents (
    id          bigserial PRIMARY KEY,
    user_id     bigint  NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    job_id      bigint  REFERENCES jobs (id) ON DELETE CASCADE,
    profile_id  bigint  NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
    kind        text    NOT NULL CHECK (kind IN ('resume', 'cover_letter')),
    tone        text,
    -- The structured content the renderers turn into DOCX/PDF/TXT, kept so a
    -- document can be re-rendered in another format without re-calling the AI.
    content     jsonb   NOT NULL,
    -- Which claims were emphasised, and the profile evidence behind each. This
    -- is the audit trail for the truthfulness rule (spec section 23).
    provenance  jsonb   NOT NULL DEFAULT '{}',
    ai_model    text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_documents_job ON documents (user_id, job_id, kind);

CREATE TABLE IF NOT EXISTS notifications (
    id         bigserial PRIMARY KEY,
    user_id    bigint  NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    job_id     bigint  REFERENCES jobs (id) ON DELETE CASCADE,
    title      text    NOT NULL,
    body       text    NOT NULL,
    read_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications (user_id) WHERE read_at IS NULL;
