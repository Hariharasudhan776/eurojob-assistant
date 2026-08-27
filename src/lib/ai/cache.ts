import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cacheGet, cacheSet } from '../db/repo.ts';
import type { CacheStore, Usage } from './client.ts';

/**
 * Cache that survives between commands.
 *
 * The original in-memory cache was worse than useless for the actual usage
 * pattern. Every `npm run jobs:analyse` is a fresh process, so the cache was
 * empty every time and four development runs paid full price for substantially
 * the same work -- four runs, zero cache hits, USD 2.53.
 *
 * One file per entry rather than one big JSON blob: entries are written from
 * separate runs, and a single file would make concurrent runs clobber each
 * other's results.
 *
 * The key is content-addressed (a hash of the job text and profile version), so
 * re-running after a code change that does not affect prompts costs nothing, and
 * a job arriving from a second board reuses the first board's answer.
 */
export class FileCache implements CacheStore {
  private readonly dir: string;
  private hits = 0;
  private misses = 0;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private file(kind: string, key: string, model: string): string {
    // The model is part of the filename: a cheaper model's answer must not be
    // served when a better one was asked for.
    return join(this.dir, `${kind}__${model}__${key}.json`);
  }

  async get(kind: string, key: string, model: string): Promise<unknown | null> {
    const path = this.file(kind, key, model);
    if (!existsSync(path)) {
      this.misses += 1;
      return null;
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { value: unknown };
      this.hits += 1;
      return parsed.value;
    } catch {
      // A truncated file (killed mid-write) must be a miss, not a crash.
      this.misses += 1;
      return null;
    }
  }

  async set(kind: string, key: string, model: string, value: unknown, usage: Usage): Promise<void> {
    const path = this.file(kind, key, model);
    // Written to a temporary name then moved, so an interrupted write cannot
    // leave a half-file that later reads as valid.
    const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify({ cachedAt: new Date().toISOString(), usage, value }, null, 2));
    writeFileSync(path, readFileSync(temp));
    try {
      const { unlinkSync } = await import('node:fs');
      unlinkSync(temp);
    } catch {
      // A leftover .tmp is harmless; it is never read.
    }
  }

  get stats() {
    return { hits: this.hits, misses: this.misses };
  }

  /** What the cache is holding, for the report. */
  summary(): { entries: number; bytes: number; byKind: Record<string, number> } {
    if (!existsSync(this.dir)) return { entries: 0, bytes: 0, byKind: {} };
    const files = readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    const byKind: Record<string, number> = {};
    let bytes = 0;
    for (const file of files) {
      bytes += statSync(join(this.dir, file)).size;
      const kind = file.split('__')[0] ?? 'unknown';
      byKind[kind] = (byKind[kind] ?? 0) + 1;
    }
    return { entries: files.length, bytes, byKind };
  }
}

/**
 * The same cache, in PostgreSQL, for hosts with no writable disk.
 *
 * On a serverless platform the filesystem is read-only apart from a temporary
 * directory that does not survive the invocation, so FileCache there is not a
 * slower cache -- it is no cache, and every request pays full price. The
 * `ai_cache` table has been in the schema from the start for exactly this.
 *
 * The key is unchanged: (kind, content hash, model). A hit can only ever be the
 * answer to a byte-identical question, and the model is part of the key so a
 * cheaper model's answer is never served when a better one was asked for.
 */
export class DbCache implements CacheStore {
  private hits = 0;
  private misses = 0;

  async get(kind: string, key: string, model: string): Promise<unknown | null> {
    try {
      const value = await cacheGet(kind, key, model);
      if (value === null || value === undefined) {
        this.misses += 1;
        return null;
      }
      this.hits += 1;
      return value;
    } catch {
      // An unreachable cache must degrade to a miss, not fail the request. The
      // spend cap is the protection against that costing too much.
      this.misses += 1;
      return null;
    }
  }

  async set(kind: string, key: string, model: string, value: unknown, usage: Usage): Promise<void> {
    try {
      await cacheSet(kind, key, model, value, usage);
    } catch {
      // Failing to memoise is not worth losing an answer the user already paid
      // for; the caller has the value in hand either way.
    }
  }

  get stats() {
    return { hits: this.hits, misses: this.misses };
  }
}
