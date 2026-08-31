-- A posting is not open forever, and until now this app behaved as though it
-- were. Jobs accumulated and nothing ever left the list, so the feed slowly
-- filled with roles that were filled, withdrawn or expired weeks ago.
--
-- What this migration adds is the ability to say a posting is CLOSED. What it
-- deliberately does not add is a claim to know that with more certainty than the
-- sources support. Three liveness checks were measured against the live feed
-- before this was written, and all three failed:
--
--   * **Fetching the posting URL.** Arbeitnow answers HTTP 200 for a job from
--     any date; Adzuna's `redirect_url` is a tracking hop that answers 200, 403
--     (bot protection, on live and dead jobs alike) or 404 with no consistency;
--     The Muse answers 200. A status code from these hosts carries no signal.
--   * **Reading the page for a "no longer available" marker.** Old and new
--     postings from all three sources produced byte-for-byte the same absence of
--     any such marker.
--   * **Absence from the next sweep.** Every source returns a WINDOW, not its
--     full result set -- Adzuna the newest 150 per country by date, Arbeitnow
--     the pages it can walk before the board rate-limits it. A job drops out of
--     that window by ageing, not by closing, so absence proves nothing.
--
-- So closure is recorded from the two things that ARE known:
--
--   'expired'  -- deterministic, from dates. Nothing has seen this posting, and
--                 it has not been freshly posted, for longer than a posting
--                 stays open. Reversible by definition: if a sweep returns it
--                 again the row is reopened, because a source returning a
--                 posting is direct evidence it is live.
--   'reported' -- a human opened it and found it gone. This is the only signal
--                 with certainty behind it, and it is therefore the only one
--                 that a later sweep does NOT overturn.
--
-- Nothing is deleted (§5). A closed job keeps its row, its matches, its
-- documents and its application history; it is filtered out of the lists, and
-- "Show expired & closed" brings it back.

-- When a source last returned this posting. Distinct from `collected_at`, which
-- the upsert also touches -- keeping them separate leaves collected_at meaning
-- "first stored / last written" and gives the lifecycle rule its own column that
-- nothing else writes.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

-- Backfill: before this column existed, `collected_at` was set to now() on every
-- upsert, so it already holds exactly the fact wanted here. Only fill NULLs, so
-- re-running the migration cannot walk a real observation backwards.
UPDATE jobs SET last_seen_at = collected_at WHERE last_seen_at IS NULL;

ALTER TABLE jobs ALTER COLUMN last_seen_at SET DEFAULT now();

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS closed_at    timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS closed_reason text;

DO $$
BEGIN
    ALTER TABLE jobs ADD CONSTRAINT jobs_closed_reason_check
        CHECK (closed_reason IS NULL OR closed_reason IN ('expired', 'reported'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- Every listing query filters on "still open", which is the large majority of
-- rows, so the useful index is the partial one over the closed minority plus a
-- plain one for the sweep that sets them.
CREATE INDEX IF NOT EXISTS idx_jobs_open      ON jobs (id) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_last_seen ON jobs (last_seen_at);

COMMENT ON COLUMN jobs.last_seen_at IS
  'When a source last returned this posting. Absence from a later sweep is NOT evidence of closure -- every source returns a window, not its full result set.';
COMMENT ON COLUMN jobs.closed_at IS
  'When this posting was concluded to be no longer open. NULL means open. Never deleted; filtered out of listings and recoverable with "Show expired & closed".';
COMMENT ON COLUMN jobs.closed_reason IS
  '''expired'' = date rule, reversed automatically if a source returns the posting again. ''reported'' = a human found it gone, and a later sweep does not overturn that.';
