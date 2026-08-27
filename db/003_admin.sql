-- Admin, account approval, and AI-provider choice. Additive and idempotent:
-- every statement is IF NOT EXISTS / has a safe default, so re-running it never
-- drops or overwrites anything.

-- Whether this account can see the admin panel (user list, approvals, password
-- resets, provider toggle).
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;

-- Account lifecycle. Existing rows default to 'active' so nobody who could log
-- in yesterday is locked out; NEW signups are written as 'pending' by the signup
-- code and must be approved by an admin before they can sign in.
--   pending  -> awaiting review
--   active   -> approved, can sign in
--   rejected -> reviewed and refused
ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

-- Which LLM this user's generations go to. Only the admin can change it in the
-- UI. 'claude' keeps the original behaviour; 'gemini' uses the free Google API.
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_provider text NOT NULL DEFAULT 'claude';

-- When the account was created, so the admin can order the request list.
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
