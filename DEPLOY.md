# Deploying this

Local PostgreSQL → Neon, and the app → Vercel. Nothing here needs a paid plan.

Read the warning at the end before you invite anyone else in.

---

## 1. Neon: create the database

1. Sign in at [neon.tech](https://neon.tech) and create a project. Pick the region
   closest to where the app will run — every page load is a round trip, so a
   database in Frankfurt behind a function in Washington is slow for no reason.
2. Copy **both** connection strings from the dashboard:
   - the **pooled** one (hostname contains `-pooler`) — this is what the app uses,
     because a serverless function opens a connection per invocation and the
     pooler is what stops that exhausting the limit;
   - the **direct** one — used for migrations, which want a real session.

## 2. Create the schema in Neon

```bash
DATABASE_URL="<direct connection string>" npm run db:migrate
```

It applies `db/001_schema.sql` then `db/002_multiuser_global.sql`. Both are
idempotent — every statement is `CREATE IF NOT EXISTS` / `ADD COLUMN IF NOT
EXISTS` — so running it again is safe and never drops anything.

## 3. Copy your local data across (optional)

Skip this if you would rather start clean; the app works either way and a fresh
`npm run sync` refills the jobs.

```bash
TARGET_DATABASE_URL="<direct connection string>" npm run db:copy            # dry run
TARGET_DATABASE_URL="<direct connection string>" npm run db:copy -- --write
```

Every insert carries `ON CONFLICT DO NOTHING`, so rows already in Neon are left
exactly as they are and an interrupted run can simply be repeated. Sequences are
moved past the copied ids afterwards. `sessions` is deliberately not copied — a
cookie signed for one deployment is no use on another. `jobs.duplicate_of` points
at another row in the same table, so those links are restored in a second pass
once every row exists.

Expect step 2 to have already created one user and one profile in Neon (that is
`npm run db:migrate` loading your local `data/profile.vN.json`), so the copy
reports them as skipped. That is the same profile from the same file, so nothing
is lost — but it is why the counts do not match exactly.

Verified locally against a second PostgreSQL database: 3,885 rows across 13
tables, re-running inserted nothing further, and the app served the copy
unchanged.

## 4. Vercel

```bash
npm i -g vercel     # if you do not have it
vercel login
vercel              # first run: links the project, deploys a preview
```

Then set the environment variables. **Never** put any of these in a file that is
committed — `.env` is gitignored and must stay that way.

```bash
vercel env add DATABASE_URL production        # the POOLED Neon string
vercel env add SESSION_SECRET production      # see below
vercel env add ANTHROPIC_API_KEY production
vercel env add ADZUNA_APP_ID production
vercel env add ADZUNA_APP_KEY production
vercel env add AI_MAX_DAILY_USD production    # 2.00
vercel env add AI_MAX_RUN_USD production      # 0.50
```

Generate the session secret first, and use a **different** one from your local
`.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`SESSION_SECRET` shorter than 32 characters is a hard startup error in
production. That is deliberate: a predictable signing key means anyone can mint a
session cookie for any account, and refusing to start is better than pretending
to be secure.

Then ship it:

```bash
vercel --prod
```

The same variables can be set in the Vercel dashboard under
**Settings → Environment Variables** if you prefer clicking. Either way they live
in Vercel, never in the repository.

## 5. Keep the jobs coming

Collection takes minutes — 21 Adzuna country endpoints, Arbeitnow's pages, The
Muse's locations — which is far longer than a serverless function is allowed to
run. So the collector stays a **command**, run from somewhere that can take its
time, pointed at Neon:

```bash
DATABASE_URL="<pooled Neon string>" npm run sync
```

Windows Task Scheduler:

```bash
schtasks /create /tn "Job sync" /tr "cmd /c cd /d C:\path\to\eurojob-assistant && npm run sync" /sc daily /st 07:00
```

cron:

```bash
0 7 * * * cd /path/to/eurojob-assistant && npm run sync
```

Or GitHub Actions, if you would rather not leave a machine on — put
`DATABASE_URL`, `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` in the repository's
**Settings → Secrets → Actions**, never in the workflow file:

```yaml
# .github/workflows/sync.yml
name: sync jobs
on:
  schedule: [{ cron: '0 6 * * *' }]
  workflow_dispatch:
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm ci
      - run: npm run sync
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          ADZUNA_APP_ID: ${{ secrets.ADZUNA_APP_ID }}
          ADZUNA_APP_KEY: ${{ secrets.ADZUNA_APP_KEY }}
```

`npm run sync` uses **no AI and costs nothing**. It scores every collected job
against every registered user's profile, because scoring is arithmetic. Add
`--explain 5` only if you want AI verdicts, and note they are charged to one
user's daily cap (`--user email` chooses whom).

A user who signs up between two syncs is not left with an unscored feed: signup
scores the first batch immediately, and **My Profile → Score N unscored jobs**
finishes the rest, for free.

## 6. Sign in

There is no seeded account. Open the deployment, choose **Create account**, and
upload your profile JSON — the template is linked on that page.

The account your local CLI has been using (`APP_USER_EMAIL`, usually
`local@eurojob`) exists but has no password, because it was created before
sign-in existed. If you copied your data across and want to keep its profile,
matches and applications, give it one:

```bash
DATABASE_URL="<direct Neon string>" npm run user:password -- local@eurojob "a long passphrase"
```

---

## What is and is not protected

**Is:**

- Passwords are bcrypt at 12 rounds. The plaintext is never stored.
- The session cookie is `httpOnly`, `sameSite=lax`, and `secure` in production;
  it is a signed JWT, and every request also checks that the session row is live
  and unrevoked. Signing out revokes server-side, so a copied cookie stops
  working.
- Every query that touches a score joins through the caller's own profile, so
  there is no query shape that can return another user's match, document, or
  application.
- The AI spend cap is per user and checked before each request, with the charge
  written durably before the response is sent.
- TLS is required for any non-loopback database host.

**Is not:**

- **No password reset by email.** Nothing sends mail. Use
  `npm run user:password` on the server.
- **No rate limiting on sign-in.** Bcrypt at 12 rounds makes online guessing
  slow, but it is not a lockout. If this is ever more than a handful of people,
  put it behind something that counts attempts.
- **No email verification.** Anyone who can reach the URL can create an account
  and spend their own $2/day of *your* API credit. Keep the deployment private,
  or add an invite check, if that matters to you.
- **No admin interface.** Accounts are managed with SQL and the CLI.
