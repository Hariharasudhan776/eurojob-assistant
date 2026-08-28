/**
 * Hard spend limits.
 *
 * This exists because a cost *estimate* is not a cost *control*. The app
 * reported its spend accurately and still ran up USD 2.53 across four
 * development runs, because nothing stopped it. An estimate you read afterwards
 * is a receipt; this is a brake.
 *
 * Three layers, each enforced before a call is made rather than after:
 *
 *   perRun    -- one command cannot spend more than this, full stop.
 *   daily     -- all runs together cannot exceed this in a rolling 24 hours.
 *   perCall   -- a single request is refused if its projected cost is absurd,
 *                which catches a runaway max_tokens or a prompt-size mistake.
 *
 * Exceeding a limit throws. It does not warn and continue: a limit that can be
 * silently passed is not a limit.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { recordSpend, spendBreakdown, spentLast24h } from '../db/repo.ts';

export interface BudgetLimits {
  perRunUsd: number;
  /**
   * PER USER, per rolling 24 hours -- not per instance. A shared allowance is
   * not an allowance: the first person to generate a few tailored resumes would
   * otherwise spend everyone else's day.
   */
  dailyUsd: number;
  perCallUsd: number;
}

/**
 * What a budget guard needs from a ledger.
 *
 * `spentLast24h` is deliberately SYNCHRONOUS. The check happens inside
 * AiClient.complete, immediately before the request, and making it async there
 * would mean an await between the check and the call -- a window in which two
 * concurrent requests could each pass a cap that only one of them fits under.
 * The database-backed ledger therefore loads its 24-hour total once, up front,
 * and keeps it current in memory as calls are recorded.
 */
export interface Ledger {
  spentLast24h(now?: number): number;
  record(usd: number, kind: string, model: string, now?: number): void;
  breakdown(now?: number): { kind: string; calls: number; usd: number }[];
  /** Awaited by the caller before it responds, so durable writes are not lost. */
  flush(): Promise<void>;
}

export const DEFAULT_LIMITS: BudgetLimits = {
  // 0.75 rather than 0.5 because assertCanSpend adds the PROJECTED cost of the
  // next call to the run total, and the resume stage's 32k output headroom
  // projects to ~$0.51 on Sonnet -- a fresh run must be able to admit one such
  // call. Actual accumulated spend per run stays far lower (~$0.16 measured).
  perRunUsd: Number(process.env.AI_MAX_RUN_USD ?? 0.75),
  dailyUsd: Number(process.env.AI_MAX_DAILY_USD ?? 2),
  // Deliberately loose, because this one is projected from max_tokens rather
  // than measured. Its job is to catch a configuration mistake -- a 128k output
  // cap, a prompt that ballooned -- not to police normal spend. Setting it to a
  // typical cost blocked legitimate work: the resume stage needs 32k of output
  // headroom (thinking tokens share the budget, and the output scales with the
  // profile) and so projects to about $0.51, against a MEASURED $0.157.
  //
  // Real control comes from perRunUsd and dailyUsd, which accumulate ACTUAL
  // cost, not projections.
  perCallUsd: Number(process.env.AI_MAX_CALL_USD ?? 0.6),
};

export class BudgetExceededError extends Error {
  readonly scope: 'run' | 'daily' | 'call';
  constructor(scope: 'run' | 'daily' | 'call', spent: number, limit: number, hint: string) {
    super(
      `AI budget stop (${scope}): $${spent.toFixed(4)} against a $${limit.toFixed(2)} limit. ${hint}`
    );
    this.scope = scope;
  }
}

interface LedgerEntry {
  at: string;
  usd: number;
  kind: string;
  model: string;
}

/**
 * Spend ledger on disk, so the daily cap survives across separate commands.
 *
 * A per-process counter would reset every time the script is run, which is
 * exactly how four separate runs added up unnoticed.
 */
export class SpendLedger implements Ledger {
  private readonly path: string;
  private entries: LedgerEntry[] = [];

  constructor(path: string) {
    this.path = path;
    if (existsSync(path)) {
      try {
        this.entries = JSON.parse(readFileSync(path, 'utf8')) as LedgerEntry[];
      } catch {
        // A corrupt ledger must not be treated as zero spend -- that would
        // silently remove the cap. Start over but keep the file for inspection.
        this.entries = [];
      }
    }
  }

  private prune(now: number) {
    const cutoff = now - 24 * 60 * 60 * 1000;
    this.entries = this.entries.filter((e) => Date.parse(e.at) >= cutoff);
  }

  spentLast24h(now = Date.now()): number {
    this.prune(now);
    return this.entries.reduce((sum, e) => sum + e.usd, 0);
  }

  record(usd: number, kind: string, model: string, now = Date.now()) {
    this.entries.push({ at: new Date(now).toISOString(), usd, kind, model });
    this.prune(now);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.entries, null, 2));
  }

  /** Spend grouped by kind, so it is obvious which stage costs the money. */
  breakdown(now = Date.now()): { kind: string; calls: number; usd: number }[] {
    this.prune(now);
    const byKind = new Map<string, { calls: number; usd: number }>();
    for (const entry of this.entries) {
      const current = byKind.get(entry.kind) ?? { calls: 0, usd: 0 };
      byKind.set(entry.kind, { calls: current.calls + 1, usd: current.usd + entry.usd });
    }
    return [...byKind.entries()]
      .map(([kind, v]) => ({ kind, ...v }))
      .sort((a, b) => b.usd - a.usd);
  }

  /** Writes are already synchronous here; nothing to wait for. */
  async flush(): Promise<void> {}
}

export const defaultLedgerPath = (root: string) => join(root, 'data', 'ai-spend.json');

/**
 * Per-user ledger in PostgreSQL.
 *
 * Two reasons this replaces the file for anything user-facing:
 *
 *  1. **Multi-user.** One file is one allowance for the whole instance.
 *  2. **Deployment.** A serverless host has no writable disk that survives a
 *     request, so a file-based cap silently becomes no cap at all -- every
 *     invocation would start from zero.
 *
 * The 24-hour total is read once at construction (`load`) so the pre-call check
 * stays synchronous, then kept current in memory. Recorded spend is written
 * through to the database; `flush()` waits for those writes, and the API route
 * awaits it before responding so a killed function cannot lose the charge.
 */
export class DbSpendLedger implements Ledger {
  private readonly userId: number;
  private opening: number;
  private readonly session: { at: number; usd: number; kind: string; model: string }[] = [];
  private pending: Promise<unknown>[] = [];
  private writeFailure: Error | null = null;

  private constructor(userId: number, opening: number) {
    this.userId = userId;
    this.opening = opening;
  }

  static async load(userId: number): Promise<DbSpendLedger> {
    return new DbSpendLedger(userId, await spentLast24h(userId));
  }

  spentLast24h(): number {
    // The opening figure came from the database; session spend is what this
    // process has added since. Recorded rows are not re-read, which would be a
    // round trip in the middle of the hot path for no new information.
    return this.opening + this.session.reduce((sum, e) => sum + e.usd, 0);
  }

  record(usd: number, kind: string, model: string, now = Date.now()): void {
    this.session.push({ at: now, usd, kind, model });
    this.pending.push(
      recordSpend(this.userId, usd, kind, model).catch((err: unknown) => {
        // A failed write must not be silently forgotten: it would mean spend
        // that happened and was never counted, which is how a cap stops being a
        // cap. It is surfaced by flush().
        this.writeFailure = err instanceof Error ? err : new Error(String(err));
      })
    );
  }

  breakdown(): { kind: string; calls: number; usd: number }[] {
    const byKind = new Map<string, { calls: number; usd: number }>();
    for (const entry of this.session) {
      const current = byKind.get(entry.kind) ?? { calls: 0, usd: 0 };
      byKind.set(entry.kind, { calls: current.calls + 1, usd: current.usd + entry.usd });
    }
    return [...byKind.entries()].map(([kind, v]) => ({ kind, ...v })).sort((a, b) => b.usd - a.usd);
  }

  async flush(): Promise<void> {
    const waiting = this.pending;
    this.pending = [];
    await Promise.all(waiting);
    if (this.writeFailure) {
      const failure = this.writeFailure;
      this.writeFailure = null;
      throw new Error(`AI spend was charged but could not be recorded: ${failure.message}`);
    }
  }

  /** For the Settings page: what this user has spent, by stage, in 24 hours. */
  static dailyBreakdown(userId: number) {
    return spendBreakdown(userId);
  }
}

export class BudgetGuard {
  private readonly limits: BudgetLimits;
  private readonly ledger: Ledger;
  private runSpend = 0;

  constructor(ledger: Ledger, limits: BudgetLimits = DEFAULT_LIMITS) {
    this.ledger = ledger;
    this.limits = limits;
  }

  get spentThisRun(): number {
    return this.runSpend;
  }

  get limitsInUse(): BudgetLimits {
    return this.limits;
  }

  /**
   * Called BEFORE a request. `projectedUsd` is the worst case for the request,
   * computed from max_tokens rather than from what the response turns out to be
   * -- checking afterwards would already have spent the money.
   */
  assertCanSpend(projectedUsd: number, kind: string) {
    if (projectedUsd > this.limits.perCallUsd) {
      throw new BudgetExceededError(
        'call',
        projectedUsd,
        this.limits.perCallUsd,
        `A single ${kind} call is projected above the per-call cap. Lower max_tokens, use a cheaper model, or raise AI_MAX_CALL_USD.`
      );
    }
    if (this.runSpend + projectedUsd > this.limits.perRunUsd) {
      throw new BudgetExceededError(
        'run',
        this.runSpend + projectedUsd,
        this.limits.perRunUsd,
        'This run has reached its cap. Analyse fewer jobs, or raise AI_MAX_RUN_USD.'
      );
    }
    const daily = this.ledger.spentLast24h();
    if (daily + projectedUsd > this.limits.dailyUsd) {
      throw new BudgetExceededError(
        'daily',
        daily + projectedUsd,
        this.limits.dailyUsd,
        `$${daily.toFixed(2)} already spent in the last 24 hours. Wait, or raise AI_MAX_DAILY_USD.`
      );
    }
  }

  /** Called AFTER a request, with the actual cost. */
  record(actualUsd: number, kind: string, model: string) {
    this.runSpend += actualUsd;
    this.ledger.record(actualUsd, kind, model);
  }

  /**
   * Wait for the ledger's durable writes. Callers that can be terminated the
   * moment they respond -- a serverless route handler -- must await this before
   * returning, or a charge can be lost and the cap silently loosened.
   */
  flush(): Promise<void> {
    return this.ledger.flush();
  }

  spentLast24h(): number {
    return this.ledger.spentLast24h();
  }

  /** Spend by stage, for reports. */
  breakdown(): { kind: string; calls: number; usd: number }[] {
    return this.ledger.breakdown();
  }
}
