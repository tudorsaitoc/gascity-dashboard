// Refinery summary state: the two host-side reads and their aggregation.
//
// River scan cost model: nerve river days run 30-100MB+ of NDJSON, almost
// all of it heartbeat noise. Reading the whole window per request is not
// viable, so the scanner exploits the one structural fact of daily logs:
// past days are immutable. Each file's matched events are computed once and
// cached keyed by (path, size); only the current day's file grows, and it
// is re-read incrementally from the last byte offset. A cheap substring
// probe rejects non-matching lines before any JSON.parse.
//
// All state lives on this class (constructed inside mount()) — no
// module-level mutable singletons (module-author-checklist §2).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type {
  RefineryGateStats,
  RefineryMergeItem,
  RefineryPoolItem,
  RefinerySourceStatus,
  RefinerySummary,
} from 'gas-city-dashboard-shared';
import type { RefineryModuleConfig } from '../../../config.js';
import { execBdRefineryPool, ExecError } from '../../../exec.js';
import { LOG_COMPONENT, logError } from '../../../logging.js';

const REFINERY = LOG_COMPONENT.refinery;
const SUMMARY_TTL_MS = 30_000;
// Hard cap on matched events kept in memory per file — the four kinds run
// a few hundred per week; this bound only matters if a future kind rename
// makes the probe over-match.
const MAX_EVENTS_PER_FILE = 20_000;

// The four river kinds this lens reads. The probe accepts both NDJSON
// spacings ("kind": "x" from python json.dumps, "kind":"x" from compact
// writers); exactness is enforced after parse by KINDS membership.
const KIND_SCORE = 'refinery.score';
const KIND_PUBLISH = 'refinery.publish.completed';
const KIND_CLOSED = 'refinery.bead.closed_on_merge';
const KIND_PR_MERGED = 'pr.merged';
const KINDS = new Set([KIND_SCORE, KIND_PUBLISH, KIND_CLOSED, KIND_PR_MERGED]);
const KIND_PROBES = [...KINDS].flatMap((k) => [`"kind": "${k}"`, `"kind":"${k}"`]);

interface RiverEvent {
  ts: string;
  kind: string;
  data: Record<string, unknown>;
}

interface FileScan {
  size: number;
  events: RiverEvent[];
}

const LOG_NAME_RE = /^events-\d{4}-\d{2}-\d{2}\.jsonl$/;

function lineMatches(line: string): boolean {
  for (const probe of KIND_PROBES) {
    if (line.includes(probe)) return true;
  }
  return false;
}

function parseEvent(line: string): RiverEvent | null {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const ts = raw.ts;
    const kind = raw.kind;
    const data = raw.data;
    if (typeof ts !== 'string' || typeof kind !== 'string' || !KINDS.has(kind)) return null;
    return { ts, kind, data: (data ?? {}) as Record<string, unknown> };
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx] ?? null;
}

export class RefinerySummaryState {
  private readonly fileCache = new Map<string, FileScan>();
  private cached: RefinerySummary | null = null;
  private cachedAt = 0;
  private inFlight: Promise<RefinerySummary> | null = null;

  constructor(
    private readonly config: RefineryModuleConfig,
    private readonly now: () => number = Date.now,
    private readonly poolExec: typeof execBdRefineryPool = execBdRefineryPool,
  ) {}

  /** Serve the cached summary within TTL; coalesce concurrent refreshes. */
  async summary(): Promise<RefinerySummary> {
    if (this.cached !== null && this.now() - this.cachedAt < SUMMARY_TTL_MS) {
      return this.cached;
    }
    this.inFlight ??= this.build().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Warm the caches at boot so the first page load skips the backfill. */
  async warm(): Promise<void> {
    try {
      await this.summary();
    } catch (err) {
      logError(REFINERY, `warm failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async build(): Promise<RefinerySummary> {
    const [poolRead, riverRead] = await Promise.all([this.readPool(), this.readRiver()]);
    const summary = this.assemble(poolRead, riverRead);
    this.cached = summary;
    this.cachedAt = this.now();
    return summary;
  }

  // ── Source 1: publish pool via bd (embedded, readonly) ────────────────

  private async readPool(): Promise<{
    items: Omit<RefineryPoolItem, 'stuck'>[] | null;
    source: RefinerySourceStatus;
  }> {
    const { repoPath, routedTo } = this.config;
    if (repoPath.length === 0 || routedTo.length === 0) {
      return {
        items: null,
        source: {
          status: 'unavailable',
          reason: 'pool source not configured (REFINERY_REPO_PATH / REFINERY_ROUTED_TO)',
        },
      };
    }
    try {
      const result = await this.poolExec(path.join(repoPath, '.beads'), routedTo);
      const rows = JSON.parse(result.stdout) as Array<Record<string, unknown>>;
      if (!Array.isArray(rows)) throw new Error('bd list returned non-array JSON');
      const items = rows.flatMap((row) => {
        const beadId = str(row.id);
        if (beadId === null) return [];
        const metadata = (row.metadata ?? {}) as Record<string, unknown>;
        return [
          {
            beadId,
            title: str(row.title) ?? beadId,
            status: str(row.status) ?? 'unknown',
            branch: str(metadata.branch),
            prUrl: str(metadata.existing_pr),
            blockedReason: str(metadata.blocked_reason),
            updatedAt: str(row.updated_at),
          },
        ];
      });
      return { items, source: { status: 'ok', asOf: new Date(this.now()).toISOString() } };
    } catch (err) {
      const reason =
        err instanceof ExecError
          ? `bd read failed (${err.kind}): pool unavailable`
          : 'bd output unparseable: pool unavailable';
      logError(REFINERY, `${reason}: ${err instanceof Error ? err.message : String(err)}`);
      return { items: null, source: { status: 'unavailable', reason } };
    }
  }

  // ── Source 2: nerve river scan ─────────────────────────────────────────

  private async readRiver(): Promise<{
    events: RiverEvent[] | null;
    source: RefinerySourceStatus;
  }> {
    const dir = this.config.riverLogDir;
    if (dir.length === 0) {
      return {
        events: null,
        source: {
          status: 'unavailable',
          reason: 'river source not configured (REFINERY_RIVER_LOG_DIR)',
        },
      };
    }
    try {
      const names = (await fsp.readdir(dir)).filter((n) => LOG_NAME_RE.test(n)).sort();
      const wanted = names.slice(-this.config.windowDays);
      if (wanted.length === 0) {
        return {
          events: null,
          source: { status: 'unavailable', reason: 'no river log files in window: unavailable' },
        };
      }
      const events: RiverEvent[] = [];
      for (const name of wanted) {
        const scan = await this.scanFile(path.join(dir, name));
        events.push(...scan.events);
      }
      // Evict cache entries that fell out of the window (log rotation).
      const keep = new Set(wanted.map((n) => path.join(dir, n)));
      for (const key of this.fileCache.keys()) {
        if (!keep.has(key)) this.fileCache.delete(key);
      }
      return { events, source: { status: 'ok', asOf: new Date(this.now()).toISOString() } };
    } catch (err) {
      const reason = 'river log read failed: unavailable';
      logError(REFINERY, `${reason}: ${err instanceof Error ? err.message : String(err)}`);
      return { events: null, source: { status: 'unavailable', reason } };
    }
  }

  /**
   * Incremental per-file scan. A shrunken file (rotation/truncation) resets
   * the cache entry; an unchanged size serves the cached events; growth
   * re-reads only the tail from the cached size offset. Reading from a byte
   * offset can start mid-line only when the file was appended mid-scan —
   * the first partial line then fails the probe or the JSON.parse and is
   * dropped, which at worst delays one event to the next refresh.
   */
  private async scanFile(filePath: string): Promise<FileScan> {
    const stat = await fsp.stat(filePath);
    const cached = this.fileCache.get(filePath);
    if (cached !== undefined && cached.size === stat.size) return cached;
    const fromOffset = cached !== undefined && cached.size < stat.size ? cached.size : 0;
    const events = fromOffset > 0 && cached !== undefined ? [...cached.events] : [];
    const stream = fs.createReadStream(filePath, { start: fromOffset, encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!lineMatches(line)) continue;
        const event = parseEvent(line);
        if (event !== null && events.length < MAX_EVENTS_PER_FILE) events.push(event);
      }
    } finally {
      rl.close();
      stream.destroy();
    }
    const scan: FileScan = { size: stat.size, events };
    this.fileCache.set(filePath, scan);
    return scan;
  }

  // ── Aggregation ────────────────────────────────────────────────────────

  private assemble(
    poolRead: Awaited<ReturnType<RefinerySummaryState['readPool']>>,
    riverRead: Awaited<ReturnType<RefinerySummaryState['readRiver']>>,
  ): RefinerySummary {
    const events = riverRead.events ?? [];

    // Gate totals from publish-batch counts; every publish event carries the
    // full counts object, so summing them over the window is the rate base.
    const gate: RefineryGateStats = {
      windowDays: this.config.windowDays,
      merged: 0,
      closedOnMerge: 0,
      blockedRequiredChecks: 0,
      waitingCi: 0,
      ciFailed: 0,
      artifactGateBlocked: 0,
      llmJudgeBlocked: 0,
      mergeFailed: 0,
      passRate: null,
    };
    let lastPatrolAt: string | null = null;
    const firstSeen = new Map<string, number>();
    const merges = new Map<string, RefineryMergeItem>();

    // Pool-entry evidence: a bead is "in the refinery" when a patrol SIGHTS
    // it (a score event or a publish-batch result row). Merge events must
    // not seed first-seen — pr.merged covers every repo PR, and letting a
    // merge sight its own bead fabricates a ~0 lead time that drags the
    // median down. A merge without a prior sighting reports lead time null.
    const sight = (beadId: string | null, ts: string): void => {
      if (beadId === null) return;
      const t = Date.parse(ts);
      if (!Number.isFinite(t)) return;
      const prev = firstSeen.get(beadId);
      if (prev === undefined || t < prev) firstSeen.set(beadId, t);
    };

    for (const event of events) {
      if (event.kind === KIND_SCORE) {
        sight(str(event.data.bead_id), event.ts);
      } else if (event.kind === KIND_PUBLISH) {
        const results = event.data.results;
        if (Array.isArray(results)) {
          for (const row of results) {
            if (typeof row === 'object' && row !== null) {
              sight(str((row as Record<string, unknown>).bead_id), event.ts);
            }
          }
        }
      }
      if (event.kind === KIND_SCORE || event.kind === KIND_PUBLISH) {
        if (lastPatrolAt === null || event.ts > lastPatrolAt) lastPatrolAt = event.ts;
      }
      if (event.kind === KIND_PUBLISH) {
        const counts = (event.data.counts ?? {}) as Record<string, unknown>;
        gate.merged += num(counts.merged) ?? 0;
        gate.closedOnMerge += num(counts.closed_on_merge) ?? 0;
        gate.blockedRequiredChecks += num(counts.blocked_required_checks) ?? 0;
        gate.waitingCi += num(counts.waiting_ci) ?? 0;
        gate.ciFailed += num(counts.ci_failed) ?? 0;
        gate.artifactGateBlocked += num(counts.artifact_gate_blocked) ?? 0;
        gate.llmJudgeBlocked += num(counts.llm_judge_blocked) ?? 0;
        gate.mergeFailed += num(counts.merge_failed) ?? 0;
      } else if (event.kind === KIND_PR_MERGED) {
        const bead = str(event.data.bead_id);
        const mergedAt = str(event.data.merged_at);
        if (bead !== null && mergedAt !== null) {
          merges.set(bead, {
            beadId: bead,
            prNumber: num(event.data.pr),
            prUrl: str(event.data.pr_url),
            title: str(event.data.title),
            mergedAt,
            leadTimeMs: null,
          });
        }
      } else if (event.kind === KIND_CLOSED) {
        const bead = str(event.data.bead);
        const mergedAt = str(event.data.merged_at);
        if (bead !== null && mergedAt !== null && !merges.has(bead)) {
          merges.set(bead, {
            beadId: bead,
            prNumber: num(event.data.pr),
            prUrl: str(event.data.pr_url),
            title: null,
            mergedAt,
            leadTimeMs: null,
          });
        }
      }
    }

    const mergeItems = [...merges.values()]
      .map((m) => {
        const entry = firstSeen.get(m.beadId);
        const mergedTs = Date.parse(m.mergedAt);
        const leadTimeMs =
          entry !== undefined && Number.isFinite(mergedTs) && mergedTs >= entry
            ? mergedTs - entry
            : null;
        return { ...m, leadTimeMs };
      })
      .sort((a, b) => (a.mergedAt < b.mergedAt ? 1 : -1));

    const totalMerged = gate.merged + gate.closedOnMerge;
    const hardFailures = gate.ciFailed + gate.mergeFailed;
    gate.passRate =
      totalMerged + hardFailures > 0 ? totalMerged / (totalMerged + hardFailures) : null;

    const leadTimes = mergeItems
      .map((m) => m.leadTimeMs)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);

    const stuckMs = this.config.stuckHours * 3_600_000;
    const nowMs = this.now();
    const pool: RefineryPoolItem[] = (poolRead.items ?? []).map((item) => {
      const updated = item.updatedAt !== null ? Date.parse(item.updatedAt) : NaN;
      return {
        ...item,
        stuck: Number.isFinite(updated) && nowMs - updated > stuckMs,
      };
    });

    return {
      pool,
      poolSource: poolRead.source,
      gate,
      merges: mergeItems.slice(0, 50),
      riverSource: riverRead.source,
      lastPatrolAt,
      leadTimeMedianMs: quantile(leadTimes, 0.5),
      leadTimeP90Ms: quantile(leadTimes, 0.9),
      stuckThresholdHours: this.config.stuckHours,
    };
  }
}
