import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AiClient, type Provider } from './client.ts';
import { AiServices } from './services.ts';
import { DbCache, FileCache } from './cache.ts';
import { BudgetGuard, DbSpendLedger, DEFAULT_LIMITS } from './budget.ts';
import type { CandidateProfile } from '../resume/profile.ts';

/**
 * One place that assembles the AI stack with caching and spend caps attached.
 *
 * Both the CLI and the web routes go through here, so there is no path that can
 * reach the API without a budget guard in front of it. A second, unguarded
 * construction site is how the caps would quietly stop applying.
 *
 * It takes a `userId` because both halves of the stack are now per-user: the
 * ledger enforces that person's own daily cap, and the documents are generated
 * from that person's own profile.
 */
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Where cached answers live.
 *
 * The disk cache is the better choice locally: it is already populated, and it
 * needs no database round trip. It is the wrong choice on a serverless host,
 * where the filesystem does not survive the request -- there, FileCache is not a
 * slower cache but no cache, and every call pays full price. `AI_CACHE` forces
 * either one.
 */
export function cacheStore() {
  const explicit = process.env.AI_CACHE;
  if (explicit === 'file') return new FileCache(join(projectRoot, 'data', 'ai-cache'));
  if (explicit === 'db') return new DbCache();
  const ephemeralFilesystem = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  return ephemeralFilesystem ? new DbCache() : new FileCache(join(projectRoot, 'data', 'ai-cache'));
}

export async function aiRuntime(userId: number, profile: CandidateProfile, provider: Provider = 'claude') {
  const cache = cacheStore();
  // Loaded, not constructed: the ledger reads this user's last 24 hours up front
  // so the pre-call check can stay synchronous. See budget.ts.
  const ledger = await DbSpendLedger.load(userId);
  const guard = new BudgetGuard(ledger);
  const client = new AiClient(cache, { budget: guard, provider });
  return { client, services: new AiServices(client, profile), cache, ledger, guard, limits: DEFAULT_LIMITS };
}
