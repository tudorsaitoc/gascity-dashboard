import fs from 'node:fs/promises';
import path from 'node:path';
import type { SlungState, TriageKind } from 'gas-city-dashboard-shared';
import { LOG_COMPONENT, errorMessage, logWarn } from '../logging.js';

// Active sling state persistence (gascity-dashboard-9qs).
//
// JSON map keyed by `kind:number`. Single-repo scope: this dashboard
// runs against one Gas City fork at a time, and the slung-state file lives
// in the same directory as the maintainer envelope cache, so the directory
// itself carries the repo scope.
//
// Atomic tmp+rename mirrors backend/src/maintainer/storage.ts. An
// in-process Promise-chain mutex serialises read-modify-write so two
// concurrent slings to different items don't lose updates to the
// classic read-old / modify / write-newer race. The mutex is courtesy:
// the tmp+rename is the correctness guarantee against torn writes.
//
// Read failures (missing file, malformed JSON, wrong top-level shape)
// return an empty map plus an operational warning — never throw. This file is
// derived bookkeeping; a corrupt copy must not break the maintainer
// view's serve path.

export type SlungStateMap = Record<string, SlungState>;

/**
 * Stable key for a TriageItem in the slung-state map.
 * Use this rather than concatenating inline so the format stays
 * consistent across read, write, and purge call sites.
 */
export function slungKey(kind: TriageKind, number: number): string {
  return `${kind}:${number}`;
}

export async function readSlungState(statePath: string): Promise<SlungStateMap> {
  try {
    const raw = await fs.readFile(statePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidStateMap(parsed)) {
      logWarn(LOG_COMPONENT.maintainer, `slung-state at ${statePath} failed shape check; ignoring`);
      return {};
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    logWarn(LOG_COMPONENT.maintainer, `slung-state read failed: ${errorMessage(err)}`);
    return {};
  }
}

// Serialise read-modify-write across concurrent writers in this
// process. Single chain — every writer waits for the prior to finish
// before reading the current map. Different paths share the chain
// (one mutex covers the slung-state file; this module owns a single
// file per process). If multi-process writers ever appear, swap for
// per-path fs locking via proper-lockfile or similar.
let writeChain: Promise<void> = Promise.resolve();

export async function writeSlungEntry(
  statePath: string,
  key: string,
  entry: SlungState,
): Promise<void> {
  const next = writeChain.then(async () => {
    const current = await readSlungState(statePath);
    current[key] = entry;
    await persistAtomic(statePath, current);
  });
  keepWriteChainAlive(next, 'write');
  await next;
}

export async function purgeSlungKeys(
  statePath: string,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) return;
  const next = writeChain.then(async () => {
    const current = await readSlungState(statePath);
    let mutated = false;
    for (const k of keys) {
      if (k in current) {
        delete current[k];
        mutated = true;
      }
    }
    if (mutated) await persistAtomic(statePath, current);
  });
  keepWriteChainAlive(next, 'purge');
  await next;
}

function keepWriteChainAlive(next: Promise<void>, operation: 'write' | 'purge'): void {
  writeChain = next.catch((err: unknown) => {
    logWarn(LOG_COMPONENT.maintainer, `slung-state ${operation} failed: ${errorMessage(err)}`);
  });
}

async function persistAtomic(statePath: string, state: SlungStateMap): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
  await fs.rename(tmp, statePath);
}

function isValidStateMap(v: unknown): v is SlungStateMap {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  for (const entry of Object.values(v)) {
    if (typeof entry !== 'object' || entry === null) return false;
    const e = entry as Partial<SlungState>;
    if (typeof e.slung_at !== 'string') return false;
    if (typeof e.target !== 'string') return false;
    if (e.bead_id !== null && typeof e.bead_id !== 'string') return false;
    // Current writers always persist the field. Missing means this is not the
    // slung-state shape the dashboard renders.
    if (
      e.resolved_session_name !== null &&
      typeof e.resolved_session_name !== 'string'
    ) {
      return false;
    }
  }
  return true;
}
