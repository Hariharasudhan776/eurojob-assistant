-- Store the CV a new user signs up with, as text.
--
-- Signing up used to require a hand-written profile JSON, which is 690 lines in
-- the one real example and is the reason nobody but the author ever made an
-- account. A CV is what people already have.
--
-- Text, not the original file. Two reasons, and both matter:
--
--   * Extraction is deterministic and free. Reading a PDF costs nothing and
--     cannot be wrong in an interesting way; interpreting it into a profile is a
--     model call that costs money. Splitting them lets the free half run for an
--     anonymous visitor while the paid half waits until there is an approved
--     account with its own budget behind it. An anonymous endpoint that calls a
--     model is an open tap.
--   * Keeping the binary would mean storing an identity document -- name,
--     address, phone, employment history -- in its original, forwardable form,
--     for an account that may never be approved. The text is what the app
--     actually needs.
--
-- Additive and re-runnable, like every migration here. Nothing is dropped and
-- no existing row changes: users who signed up with JSON keep their profile and
-- these columns stay null.

ALTER TABLE users ADD COLUMN IF NOT EXISTS cv_text TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS cv_filename TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS cv_uploaded_at TIMESTAMPTZ;

COMMENT ON COLUMN users.cv_text IS
  'Plain text of the CV supplied at signup. Drafted into a profile after approval, on the user''s own budget. Null for accounts created from a JSON profile.';
