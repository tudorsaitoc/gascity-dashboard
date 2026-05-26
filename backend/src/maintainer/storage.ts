import fs from 'node:fs/promises';
import path from 'node:path';
import type { MaintainerTriage, TriageItem } from 'gas-city-dashboard-shared';

// Atomic JSON cache for the maintainer triage view.
// Reads are best-effort: missing file or parse error returns null so the
// route can fall back to a freshly-fetched empty envelope without ever
// 500ing on a corrupted file. Writes go through a sibling tmp file +
// rename so a crashed write never leaves a half-written cache that the
// next process would choke on.
//
// SQLite is deliberately not used here (gascity-dashboard-361 decision):
// the dataset is small (<50KB even for repos with hundreds of items),
// there's no multi-process concurrency to coordinate, and zero new
// dependencies stays in keeping with the project's "calm tool" ethos.
// A later bead can swap this for SQLite if the cache grows multi-repo
// or wants history retention.

export async function readCache(
  cachePath: string,
): Promise<MaintainerTriage | null> {
  try {
    const raw = await fs.readFile(cachePath, 'utf-8');
    const parsed = JSON.parse(raw) as MaintainerTriage;
    if (!isValidEnvelope(parsed)) {
      console.warn(`[maintainer] cache at ${cachePath} failed shape check; ignoring`);
      return null;
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    console.warn(`[maintainer] cache read failed: ${(err as Error).message}`);
    return null;
  }
}

export async function writeCache(
  cachePath: string,
  envelope: MaintainerTriage,
): Promise<void> {
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(envelope, null, 2), 'utf-8');
  await fs.rename(tmp, cachePath);
}

// Required keys spot-checked on the first TriageItem we find in the envelope.
// A cache written before a new required field shipped will deserialise with
// the key entirely absent; checking via `in` (rather than `!= null`) lets
// genuinely nullable fields like triage_score / triage_assessment pass when
// explicitly null while still rejecting pre-migration caches.
//
// CONTRACT: any new required field on TriageItem needs a one-line addition
// here. Failure to add one means a stale cache silently survives the shape
// check and lands at consumers with `undefined`, forcing every reader to
// add a loose-null guard. See gascity-dashboard-3qy.
// The `satisfies` clause is load-bearing: it makes a rename on TriageItem
// (e.g. `triage_assessment` → `triage_result`) a compile error here, so the
// CONTRACT comment above is enforced by the type system rather than memory.
const REQUIRED_TRIAGE_ITEM_KEYS = [
  'number',
  'kind',
  'status',
  'triage_score',
  'triage_assessment',
  'is_marked',
  'has_in_flight_pr',
] as const satisfies ReadonlyArray<keyof TriageItem>;

function firstTriageItem(env: MaintainerTriage): unknown {
  // Traversal order MUST match triage.ts collectItems (the source of truth for
  // how the envelope is walked): unclustered first, then clusters[*].items.
  // Keeping the validator's "first item" in lockstep with the walker is the
  // contract noted above (gascity-dashboard-34m).
  for (const tier of env.tiers) {
    if (!tier || typeof tier !== 'object') continue;
    const unclustered = Array.isArray(tier.unclustered) ? tier.unclustered : [];
    if (unclustered.length > 0) return unclustered[0];
    const clusters = Array.isArray(tier.clusters) ? tier.clusters : [];
    for (const cluster of clusters) {
      if (cluster && Array.isArray(cluster.items) && cluster.items.length > 0) {
        return cluster.items[0];
      }
    }
  }
  return undefined;
}

function isValidEnvelope(v: unknown): v is MaintainerTriage {
  if (typeof v !== 'object' || v === null) return false;
  const env = v as Partial<MaintainerTriage>;
  const topLevelOk =
    typeof env.repo === 'string' &&
    Array.isArray(env.tiers) &&
    typeof env.totals === 'object' &&
    env.totals !== null &&
    typeof (env.totals as { issues_open: unknown }).issues_open === 'number' &&
    typeof (env.totals as { prs_open: unknown }).prs_open === 'number';
  if (!topLevelOk) return false;

  // Deep spot-check the first TriageItem we find. An empty envelope (no
  // items in any tier) passes the wire-shape check — the next worker tick
  // will repopulate; there's nothing to invalidate yet.
  const sample = firstTriageItem(env as MaintainerTriage);
  if (sample === undefined) return true;
  if (typeof sample !== 'object' || sample === null) return false;
  for (const key of REQUIRED_TRIAGE_ITEM_KEYS) {
    if (!(key in sample)) return false;
  }
  return true;
}
