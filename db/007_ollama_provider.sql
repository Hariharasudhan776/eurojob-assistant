-- A third provider: a model server you run yourself.
--
-- `ai_provider` now takes 'ollama' alongside 'claude' and 'gemini'. It is the
-- only one of the three that bills nobody and sends nothing to a third party:
-- the prompts -- which carry the whole candidate profile -- never leave the
-- network the model is running on.
--
-- New accounts default to it. Gemini's free tier is also free, but it is free
-- at someone else's discretion: a quota change, a deprecated model name or a
-- region restriction all arrive without warning, and a box in the next room
-- does not.
--
-- Existing rows are deliberately NOT changed, for the same reason migration 005
-- gave: a migration is the wrong place to silently move an account someone is
-- relying on. Move them from the admin panel, or, to move every account off the
-- paid provider in one go:
--
--     UPDATE users SET ai_provider = 'ollama' WHERE ai_provider = 'claude';
--
-- The column stays plain text rather than gaining a CHECK constraint, because a
-- fourth provider should be a code change and an env var, not a migration.

ALTER TABLE users ALTER COLUMN ai_provider SET DEFAULT 'ollama';

COMMENT ON COLUMN users.ai_provider IS
  'Which model this account generates with: claude (paid, billed to the deployment owner), gemini (Google free tier) or ollama (self-hosted, no key, no bill, no data leaving the network). Set only by an admin.';
