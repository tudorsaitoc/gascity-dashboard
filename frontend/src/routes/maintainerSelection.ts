import type { TriageItem } from 'gas-city-dashboard-shared';

// Pure helpers for the maintainer bulk-sling selection state
// (gascity-dashboard-0nn). Lives outside Maintainer.tsx so vitest can
// exercise the logic without rendering React. Selection is in-memory
// only; a page refresh clears it (bulk triage is a 'do it now'
// operation, not a saved view).

export interface SelectionKey {
  readonly kind: 'pr' | 'issue';
  readonly number: number;
}

export interface SlingRequest {
  readonly kind: 'pr' | 'issue';
  readonly number: number;
  readonly html_url: string;
  readonly intent: 'triage';
  readonly target?: string;
}

/**
 * String key for use in a `Set<string>`. Composite of kind + number so a
 * PR and an issue sharing the same number can both be selected.
 */
export function selectionKey(item: SelectionKey): string {
  return `${item.kind}:${item.number}`;
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
      intent: 'triage',
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
 * Fan out one POST per request in parallel via Promise.allSettled so a
 * single 4xx/5xx doesn't block the rest of the batch. Returns a structured
 * summary the UI can use to decide whether to clear the selection or
 * leave the failed subset selected for retry.
 *
 * The send fn is injected so vitest can stub without mocking the global
 * fetch — same DI shape as backend execGcSling.
 */
export async function dispatchSlings(
  requests: ReadonlyArray<SlingRequest>,
  send: (req: SlingRequest) => Promise<unknown>,
): Promise<SlingSummary> {
  const settled = await Promise.allSettled(requests.map((r) => send(r)));
  const outcomes: SlingOutcome[] = settled.map((result, i) => {
    const request = requests[i]!;
    if (result.status === 'fulfilled') {
      return { request, ok: true };
    }
    const reason = result.reason as unknown;
    const error =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : 'sling failed';
    return { request, ok: false, error };
  });
  const succeeded = outcomes.filter((o) => o.ok).length;
  return { outcomes, succeeded, failed: outcomes.length - succeeded };
}
