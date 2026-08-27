-- New accounts start on the free model, not the paid one.
--
-- There is ONE `ANTHROPIC_API_KEY` for the whole deployment, so every account
-- left on Claude spends the owner's money -- up to its own $2/day cap, which is
-- roughly twelve tailored resumes a day, per person, on the owner's card. The
-- column was created with DEFAULT 'claude', so every account approved since
-- then has been billing the owner by default rather than by decision.
--
-- Gemini's free tier produces work this app measures as equivalent: on job 2172
-- both providers scored 88/100 on the document audit, placed 10 of 10 matched
-- terms in the top third, and leaked no unconfirmed term. Claude was better on
-- prose and took four times as long; that is a difference worth paying for by
-- choice, not by default.
--
-- Existing rows are deliberately NOT changed. Someone may already be relying on
-- Claude, and a migration is the wrong place to silently downgrade an account
-- that is in use. The admin panel now shows the provider per account and can
-- move any of them either way.

ALTER TABLE users ALTER COLUMN ai_provider SET DEFAULT 'gemini';

COMMENT ON COLUMN users.ai_provider IS
  'Which model this account generates with. Set only by an admin: one API key pays for everyone, so moving an account onto Claude spends the owner''s money. Defaults to the free provider.';
