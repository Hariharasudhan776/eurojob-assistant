import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AiClient } from './client.ts';
import { AiServices } from './services.ts';
import { FileCache } from './cache.ts';
import { BudgetGuard, SpendLedger, defaultLedgerPath, DEFAULT_LIMITS } from './budget.ts';
import type { CandidateProfile } from '../resume/profile.ts';

/**
 * One place that assembles the AI stack with caching and spend caps attached.
 *
 * Both the CLI and the web routes go through here, so there is no path that can
 * reach the API without a budget guard in front of it. A second, unguarded
 * construction site is how the caps would quietly stop applying.
 */
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function aiRuntime(profile: CandidateProfile) {
  const cache = new FileCache(join(projectRoot, 'data', 'ai-cache'));
  const ledger = new SpendLedger(defaultLedgerPath(projectRoot));
  const guard = new BudgetGuard(ledger);
  const client = new AiClient(cache, { budget: guard });
  return { client, services: new AiServices(client, profile), cache, ledger, guard, limits: DEFAULT_LIMITS };
}
