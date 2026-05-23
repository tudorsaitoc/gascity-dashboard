import { describe, expect, it } from 'vitest';
import type { TriageItem } from 'gas-city-dashboard-shared';
import {
  buildSlingRequests,
  dispatchSlings,
  flattenTriageItems,
  selectionKey,
  toggleSelectionItem,
  type SlingRequest,
} from './maintainerSelection';

// Tests for the pure selection-state helpers backing the bulk-sling
// action bar on the maintainer triage view (gascity-dashboard-0nn).
// Logic lives outside Maintainer.tsx so vitest doesn't need to render
// the React tree to assert these invariants.

function mkItem(overrides: Partial<TriageItem> & { kind: 'pr' | 'issue'; number: number }): TriageItem {
  return {
    kind: overrides.kind,
    number: overrides.number,
    title: overrides.title ?? `Item ${overrides.number}`,
    html_url:
      overrides.html_url ??
      `https://github.com/gastownhall/gascity/${overrides.kind === 'pr' ? 'pull' : 'issues'}/${overrides.number}`,
    labels: overrides.labels ?? [],
    status: overrides.status ?? 'open',
    author: overrides.author ?? {
      login: 'someone',
      tier: 'regular',
      issues_opened: null,
      issues_accepted: null,
      prs_opened: null,
      prs_merged: null,
      computed_at: null,
    },
    tier: overrides.tier ?? null,
    triage_score: overrides.triage_score ?? null,
    cluster_id: overrides.cluster_id ?? null,
    blast_files: overrides.blast_files ?? [],
    lines_changed: overrides.lines_changed ?? null,
    is_marked: overrides.is_marked ?? false,
    linked_numbers: overrides.linked_numbers ?? [],
    weak_ties: overrides.weak_ties ?? [],
    created_at: overrides.created_at ?? '2026-05-20T00:00:00Z',
    updated_at: overrides.updated_at ?? '2026-05-22T00:00:00Z',
  };
}

describe('selectionKey', () => {
  it('combines kind and number so a PR and issue with the same number are distinct', () => {
    expect(selectionKey({ kind: 'pr', number: 42 })).toBe('pr:42');
    expect(selectionKey({ kind: 'issue', number: 42 })).toBe('issue:42');
  });
});

describe('toggleSelectionItem', () => {
  it('adds an item when not previously selected', () => {
    const next = toggleSelectionItem(new Set(), { kind: 'pr', number: 1 });
    expect(next.has('pr:1')).toBe(true);
    expect(next.size).toBe(1);
  });

  it('removes an item when already selected', () => {
    const initial = new Set(['pr:1']);
    const next = toggleSelectionItem(initial, { kind: 'pr', number: 1 });
    expect(next.has('pr:1')).toBe(false);
    expect(next.size).toBe(0);
  });

  it('returns a NEW Set without mutating the input (immutability contract)', () => {
    const initial = new Set(['pr:1']);
    const next = toggleSelectionItem(initial, { kind: 'issue', number: 2 });
    expect(initial.has('issue:2')).toBe(false);
    expect(initial.size).toBe(1);
    expect(next).not.toBe(initial);
  });

  it('preserves unrelated entries on toggle', () => {
    const initial = new Set(['pr:1', 'issue:9']);
    const next = toggleSelectionItem(initial, { kind: 'pr', number: 1 });
    expect(next.has('pr:1')).toBe(false);
    expect(next.has('issue:9')).toBe(true);
  });
});

describe('buildSlingRequests', () => {
  const items: TriageItem[] = [
    mkItem({ kind: 'pr', number: 10 }),
    mkItem({ kind: 'issue', number: 11 }),
    mkItem({ kind: 'pr', number: 12 }),
  ];

  it('emits one request per selected item that exists in the envelope', () => {
    const selection = new Set(['pr:10', 'issue:11']);
    const reqs = buildSlingRequests(selection, items);
    expect(reqs).toHaveLength(2);
    const keys = reqs.map((r) => `${r.kind}:${r.number}`).sort();
    expect(keys).toEqual(['issue:11', 'pr:10']);
  });

  it('always tags requests with intent="triage"', () => {
    const selection = new Set(['pr:10']);
    const reqs = buildSlingRequests(selection, items);
    expect(reqs[0]?.intent).toBe('triage');
  });

  it('copies html_url from the matched item (not synthesised)', () => {
    const selection = new Set(['issue:11']);
    const reqs = buildSlingRequests(selection, items);
    expect(reqs[0]?.html_url).toBe('https://github.com/gastownhall/gascity/issues/11');
  });

  it('omits target when none is provided so the backend default chain wins', () => {
    const selection = new Set(['pr:10']);
    const reqs = buildSlingRequests(selection, items);
    expect(reqs[0]).not.toHaveProperty('target');
  });

  it('passes target through when explicitly provided', () => {
    const selection = new Set(['pr:10']);
    const reqs = buildSlingRequests(selection, items, 'chief-of-staff');
    expect(reqs[0]?.target).toBe('chief-of-staff');
  });

  it('silently skips selected keys that no longer exist in the envelope', () => {
    // An item might close between selection and send. The user picked it;
    // skip rather than 4xx since the operator intent was clearly 'this
    // batch should be triaged'.
    const selection = new Set(['pr:10', 'pr:999', 'issue:11']);
    const reqs = buildSlingRequests(selection, items);
    expect(reqs).toHaveLength(2);
  });

  it('returns an empty array when selection is empty', () => {
    expect(buildSlingRequests(new Set(), items)).toEqual([]);
  });
});

describe('flattenTriageItems', () => {
  it('flattens every item across tiers, clusters, and unclustered lists', () => {
    const envelope = {
      tiers: [
        {
          clusters: [
            { items: [mkItem({ kind: 'pr', number: 1 }), mkItem({ kind: 'issue', number: 2 })] },
          ],
          unclustered: [mkItem({ kind: 'pr', number: 3 })],
        },
        {
          clusters: [],
          unclustered: [mkItem({ kind: 'issue', number: 4 })],
        },
      ],
    };
    const flat = flattenTriageItems(envelope);
    expect(flat.map((i) => `${i.kind}:${i.number}`).sort()).toEqual([
      'issue:2',
      'issue:4',
      'pr:1',
      'pr:3',
    ]);
  });

  it('handles an empty envelope', () => {
    expect(flattenTriageItems({ tiers: [] })).toEqual([]);
  });
});

describe('dispatchSlings', () => {
  const reqA: SlingRequest = {
    kind: 'pr',
    number: 1,
    html_url: 'https://github.com/o/r/pull/1',
    intent: 'triage',
  };
  const reqB: SlingRequest = {
    kind: 'issue',
    number: 2,
    html_url: 'https://github.com/o/r/issues/2',
    intent: 'triage',
  };

  it('reports succeeded=N when every send resolves', async () => {
    const calls: SlingRequest[] = [];
    const send = async (r: SlingRequest) => {
      calls.push(r);
      return { ok: true };
    };
    const summary = await dispatchSlings([reqA, reqB], send);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(0);
    expect(calls).toHaveLength(2);
    expect(summary.outcomes.every((o) => o.ok)).toBe(true);
  });

  it('fires all sends in parallel (does not await between them)', async () => {
    // Latch every call so none resolves until we explicitly release. If
    // dispatch awaited between sends, only one call would be in flight at
    // any given time and the gate would never see N.
    let inFlight = 0;
    let peak = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const send = async (_r: SlingRequest) => {
      inFlight += 1;
      if (inFlight > peak) peak = inFlight;
      await gate;
      inFlight -= 1;
      return { ok: true };
    };
    const promise = dispatchSlings([reqA, reqB], send);
    // Yield so the microtasks scheduling the sends actually run.
    await Promise.resolve();
    await Promise.resolve();
    expect(peak).toBe(2);
    release();
    await promise;
  });

  it('isolates a failed send: other requests still succeed', async () => {
    const send = async (r: SlingRequest) => {
      if (r.number === 1) throw new Error('boom');
      return { ok: true };
    };
    const summary = await dispatchSlings([reqA, reqB], send);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    const failed = summary.outcomes.find((o) => !o.ok);
    expect(failed?.request.number).toBe(1);
    expect(failed?.error).toBe('boom');
  });

  it('reports a non-Error rejection reason as a fallback message', async () => {
    // Promise rejections in JS can carry any value, not just Error
    // instances. Verify the helper produces a string regardless.
    const send = async () => {
      throw 'plain string reason'; // eslint-disable-line no-throw-literal
    };
    const summary = await dispatchSlings([reqA], send);
    expect(summary.failed).toBe(1);
    expect(summary.outcomes[0]?.error).toBe('plain string reason');
  });

  it('returns zero outcomes when given no requests', async () => {
    let called = 0;
    const summary = await dispatchSlings([], async () => {
      called += 1;
      return null;
    });
    expect(summary.outcomes).toEqual([]);
    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(0);
    expect(called).toBe(0);
  });
});
