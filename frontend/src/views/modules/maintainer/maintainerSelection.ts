import { useCallback, useEffect, useRef, useState } from 'react';
import type { TriageItem } from 'gas-city-dashboard-shared';
import { selectionKey, type SelectionKey } from './selectionKey';
export { selectionKey, type SelectionKey } from './selectionKey';

// Pure helpers for the maintainer bulk-sling selection state
// (gascity-dashboard-0nn). Lives outside Maintainer.tsx so vitest can
// exercise the logic without rendering React. Selection is in-memory
// only; a page refresh clears it (bulk triage is a 'do it now'
// operation, not a saved view).

/** Operator-facing sling intents in the maintainer view's bulk action bar
 *  (gascity-dashboard-5xw). `'triage'` asks an agent to assess an item
 *  (populates triage_assessment); `'draft'` asks an agent to write a PR for
 *  an issue lacking one. The backend's third intent `'review'` is not
 *  surfaced here — merging via GitHub is the operator's review workflow. */
export type MaintainerSlingIntent = 'triage' | 'draft';

export interface SlingRequest {
  readonly kind: 'pr' | 'issue';
  readonly number: number;
  readonly html_url: string;
  readonly intent: MaintainerSlingIntent;
  readonly target?: string;
}

/** Immutable add/remove on a selection set, keyed by selectionKey. */
export function toggleSelectionItem(
  current: ReadonlySet<string>,
  item: SelectionKey,
): Set<string> {
  const next = new Set(current);
  const key = selectionKey(item);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

/**
 * Build the per-item sling request payloads for every selected
 * `{kind, number}` that survives the lookup. Items that no longer exist
 * in the current envelope (e.g. closed between selection and send) are
 * silently skipped — the request would 4xx anyway, and the user already
 * picked them so the operator-side intent is clear. The optional `target`
 * is omitted when undefined so the backend's MAINTAINER_TRIAGE_TARGET /
 * MAINTAINER_SLING_TARGET fallback chain owns the routing decision.
 */
export function buildSlingRequests(
  selection: ReadonlySet<string>,
  items: ReadonlyArray<TriageItem>,
  intent: MaintainerSlingIntent = 'triage',
  target?: string,
): SlingRequest[] {
  const byKey = new Map<string, TriageItem>();
  for (const it of items) {
    byKey.set(selectionKey({ kind: it.kind, number: it.number }), it);
  }
  const out: SlingRequest[] = [];
  for (const key of selection) {
    const item = byKey.get(key);
    if (item === undefined) continue;
    const req: SlingRequest = {
      kind: item.kind,
      number: item.number,
      html_url: item.html_url,
      intent,
      ...(target !== undefined ? { target } : {}),
    };
    out.push(req);
  }
  return out;
}

/** Flatten every TriageItem in a MaintainerTriage envelope. */
export function flattenTriageItems(envelope: {
  tiers: ReadonlyArray<{
    clusters: ReadonlyArray<{ items: ReadonlyArray<TriageItem> }>;
    unclustered: ReadonlyArray<TriageItem>;
  }>;
}): TriageItem[] {
  const out: TriageItem[] = [];
  for (const tier of envelope.tiers) {
    for (const cluster of tier.clusters) {
      for (const item of cluster.items) out.push(item);
    }
    for (const item of tier.unclustered) out.push(item);
  }
  return out;
}

export interface SlingOutcome {
  readonly request: SlingRequest;
  readonly ok: boolean;
  readonly error?: string;
}

export interface SlingSummary {
  readonly outcomes: ReadonlyArray<SlingOutcome>;
  readonly succeeded: number;
  readonly failed: number;
}

/**
 * Cap on simultaneous in-flight sends inside dispatchSlings. The backend
 * exec semaphore already serialises 'gc sling' subprocesses (MAX_CONCURRENT=4),
 * but HTTP requests queue at the express handler before hitting that
 * semaphore. 8 leaves headroom over the backend cap while staying under
 * typical browser per-host connection limits, so a 20+ item bulk-triage
 * selection batches cleanly rather than stampeding.
 */
const MAX_CONCURRENT_SLINGS = 8;

/**
 * Fan out one POST per request via Promise.allSettled so a single 4xx/5xx
 * doesn't block the rest of the batch. Concurrency is capped at
 * MAX_CONCURRENT_SLINGS by processing requests in fixed-size chunks; each
 * chunk's results are concatenated in input order so outcomes[i] always
 * maps to requests[i]. Returns a structured summary the UI can use to
 * decide whether to clear the selection or leave the failed subset
 * selected for retry.
 *
 * Note: this is a chunk loop, not a sliding window — the next chunk does
 * not start until ALL items in the current chunk settle, so a single slow
 * sling drops throughput to 1 in-flight until it resolves. For the bulk-
 * triage use case (small N, single-operator localhost) this is fine; a
 * sliding-window primitive (p-limit) would be the upgrade if N grows or
 * one backend slot starts dominating tail latency.
 *
 * The send fn is injected so vitest can stub without mocking the global
 * fetch — same DI shape as backend execGcSling.
 */
export async function dispatchSlings(
  requests: ReadonlyArray<SlingRequest>,
  send: (req: SlingRequest) => Promise<unknown>,
): Promise<SlingSummary> {
  const outcomes: SlingOutcome[] = [];
  for (let i = 0; i < requests.length; i += MAX_CONCURRENT_SLINGS) {
    const chunk = requests.slice(i, i + MAX_CONCURRENT_SLINGS);
    const settled = await Promise.allSettled(chunk.map((r) => send(r)));
    for (let j = 0; j < settled.length; j += 1) {
      const result = settled[j]!;
      const request = chunk[j]!;
      if (result.status === 'fulfilled') {
        outcomes.push({ request, ok: true });
        continue;
      }
      const reason = result.reason as unknown;
      const error =
        reason instanceof Error
          ? reason.message
          : typeof reason === 'string'
            ? reason
            : 'sling failed';
      outcomes.push({ request, ok: false, error });
    }
  }
  const succeeded = outcomes.filter((o) => o.ok).length;
  return { outcomes, succeeded, failed: outcomes.length - succeeded };
}

// ── Post-sling success acknowledgement (gascity-dashboard-5ly) ────────

export interface SlingSuccess {
  readonly count: number;
  readonly target: string;
}

// 5 seconds is enough to read 'Slung N to <target>' + click the link.
// Aligned with the bead description's '~5s'. Exported so tests can pin
// the contract instead of guessing at a hardcoded ms value.
export const SLING_SUCCESS_TTL_MS = 5_000;

export interface SlingSuccessApi {
  readonly success: SlingSuccess | null;
  readonly setSuccess: (next: SlingSuccess) => void;
  readonly clearSuccess: () => void;
}

/**
 * Hook that owns the post-sling success line shown in the bulk-triage
 * action bar. The bar was previously silent on success — the operator
 * only saw it disappear, which is too quiet for a dispatch that just
 * sent N items to an agent. This hook holds:
 *
 *   - The current success line (or null)
 *   - The auto-clear timer
 *   - Cleanup on unmount
 *   - Reset on back-to-back slings (latest dispatch wins, no stacked timers)
 *
 * Lives next to the selection helpers so vitest can exercise the
 * lifecycle without rendering Maintainer.tsx.
 */
export function useSlingSuccess(): SlingSuccessApi {
  const [success, setSuccessState] = useState<SlingSuccess | null>(null);
  // Hold the timer handle outside React state so a new setSuccess can
  // cancel the prior timer synchronously. ReturnType<typeof setTimeout>
  // covers both browser (number) and Node (Timeout) typings.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const setSuccess = useCallback(
    (next: SlingSuccess) => {
      cancelTimer();
      setSuccessState(next);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        setSuccessState(null);
      }, SLING_SUCCESS_TTL_MS);
    },
    [cancelTimer],
  );

  const clearSuccess = useCallback(() => {
    cancelTimer();
    setSuccessState(null);
  }, [cancelTimer]);

  // Unmount cleanup: cancel any in-flight timer so it can't fire
  // setSuccessState against an unmounted component.
  useEffect(() => {
    return () => {
      cancelTimer();
    };
  }, [cancelTimer]);

  return { success, setSuccess, clearSuccess };
}
