import fs from 'node:fs/promises';
import path from 'node:path';
import type { MaintainerTriage, TriageItem } from 'gas-city-dashboard-shared';
import { LOG_COMPONENT, errorMessage, logWarn } from '../../../logging.js';

// Atomic JSON cache for the maintainer triage view.
// Missing file is the only cache miss. Corrupt JSON, unreadable files, and
// stale wire shapes are errors: callers decide how to surface them, but this
// layer must not collapse them into the same state as "cache not created yet."
// Writes go through a sibling tmp file + rename so a crashed write never
// leaves a half-written cache that the next process would choke on.
//
// SQLite is deliberately not used here (gascity-dashboard-361 decision):
// the dataset is small (<50KB even for repos with hundreds of items),
// there's no multi-process concurrency to coordinate, and zero new
// dependencies stays in keeping with the project's "calm tool" ethos.
// A later bead can swap this for SQLite if the cache grows multi-repo
// or wants history retention.

export type CacheReadResult =
  | { status: 'ready'; envelope: MaintainerTriage }
  | { status: 'missing' };

export async function readCache(cachePath: string): Promise<CacheReadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(cachePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    logWarn(LOG_COMPONENT.maintainer, `cache read failed: ${errorMessage(err)}`);
    throw new Error('maintainer cache read failed');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logWarn(LOG_COMPONENT.maintainer, `cache parse failed: ${errorMessage(err)}`);
    throw new Error('maintainer cache parse failed');
  }

  if (!isValidEnvelope(parsed)) {
    logWarn(LOG_COMPONENT.maintainer, `cache at ${cachePath} failed shape check`);
    throw new Error('maintainer cache shape check failed');
  }

  return { status: 'ready', envelope: parsed };
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

// Required keys checked on every TriageItem in the envelope.
// A cache written before a new required field shipped will deserialise with
// the key entirely absent; checking via `in` (rather than `!= null`) lets
// genuinely nullable fields like triage_score / triage_assessment pass when
// explicitly null while still rejecting stale caches.
//
// CONTRACT: any new required field on TriageItem needs a one-line addition
// here. Failure to add one means invalid cache data can land at consumers,
// forcing render code to defend against impossible `undefined` states.
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
] as const satisfies readonly (keyof TriageItem)[];

function* triageItems(env: MaintainerTriage): Generator<unknown> {
  for (const tier of env.tiers) {
    if (!tier || typeof tier !== 'object') continue;
    const unclustered = Array.isArray(tier.unclustered) ? tier.unclustered : [];
    yield* unclustered;
    const clusters = Array.isArray(tier.clusters) ? tier.clusters : [];
    for (const cluster of clusters) {
      if (cluster && Array.isArray(cluster.items)) {
        yield* cluster.items;
      }
    }
  }
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

  // Empty envelopes pass the wire-shape check. There are no items to validate;
  // the next worker tick will repopulate when upstream data exists.
  for (const item of triageItems(env as MaintainerTriage)) {
    if (typeof item !== 'object' || item === null) return false;
    for (const key of REQUIRED_TRIAGE_ITEM_KEYS) {
      if (!(key in item)) return false;
    }
  }
  return true;
}
