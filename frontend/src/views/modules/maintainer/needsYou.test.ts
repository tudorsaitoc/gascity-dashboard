import { describe, expect, it } from 'vitest';
import type { TriageItem, TriageTierSection } from 'gas-city-dashboard-shared';
import {
  filterTierByNeedsYou,
  isAwaitingMerge,
  isAwaitingReview,
  isChangesRequested,
  isMarked,
  isNeedsYou,
  isStalledUnvetted,
  isVettedAwaitingDecision,
  NEEDS_YOU_STALL_THRESHOLD_DAYS,
  NEEDS_YOU_STALL_THRESHOLD_MS,
} from './needsYou';

// Pure-predicate suite for the dw8 "Needs you" composite filter.
// Lives outside Maintainer.tsx so each clause can be exercised
// independently — H3 in the architect's plan review mandated documented
// clauses + per-clause tests, not a single OR'd boolean.

const NOW_ISO = '2026-05-30T12:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function mkItem(
  overrides: Partial<TriageItem> & { kind: 'pr' | 'issue'; number: number },
): TriageItem {
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
    triage_assessment: overrides.triage_assessment ?? null,
    slung: overrides.slung ?? null,
    cluster_id: overrides.cluster_id ?? null,
    blast_files: overrides.blast_files ?? [],
    lines_changed: overrides.lines_changed ?? null,
    is_marked: overrides.is_marked ?? false,
    has_in_flight_pr: overrides.has_in_flight_pr ?? false,
    linked_numbers: overrides.linked_numbers ?? [],
    weak_ties: overrides.weak_ties ?? [],
    created_at: overrides.created_at ?? '2026-05-01T00:00:00.000Z',
    updated_at: overrides.updated_at ?? NOW_ISO,
  };
}

describe('NEEDS_YOU_STALL_THRESHOLD_DAYS', () => {
  it('is 7 days, matching the JSDoc rationale', () => {
    expect(NEEDS_YOU_STALL_THRESHOLD_DAYS).toBe(7);
    expect(NEEDS_YOU_STALL_THRESHOLD_MS).toBe(7 * ONE_DAY_MS);
  });
});

describe('isChangesRequested', () => {
  it('true for status === changes_requested', () => {
    expect(isChangesRequested(mkItem({ kind: 'pr', number: 1, status: 'changes_requested' }))).toBe(
      true,
    );
  });
  it('false for any other status', () => {
    for (const status of [
      'open',
      'draft',
      'needs_review',
      'approved',
      'merged',
      'closed',
    ] as const) {
      expect(isChangesRequested(mkItem({ kind: 'pr', number: 1, status }))).toBe(false);
    }
  });
});

describe('isAwaitingReview', () => {
  it('true for status === needs_review', () => {
    expect(isAwaitingReview(mkItem({ kind: 'pr', number: 1, status: 'needs_review' }))).toBe(true);
  });
  it('false for any other status', () => {
    for (const status of [
      'open',
      'draft',
      'changes_requested',
      'approved',
      'merged',
      'closed',
    ] as const) {
      expect(isAwaitingReview(mkItem({ kind: 'pr', number: 1, status }))).toBe(false);
    }
  });
});

describe('isAwaitingMerge', () => {
  it('true only when status === approved AND kind === pr (the human-approval gate)', () => {
    expect(isAwaitingMerge(mkItem({ kind: 'pr', number: 1, status: 'approved' }))).toBe(true);
  });
  it('false when an issue carries an approved status (issues do not merge)', () => {
    expect(isAwaitingMerge(mkItem({ kind: 'issue', number: 1, status: 'approved' }))).toBe(false);
  });
  it('false for other PR statuses', () => {
    for (const status of [
      'open',
      'draft',
      'needs_review',
      'changes_requested',
      'merged',
      'closed',
    ] as const) {
      expect(isAwaitingMerge(mkItem({ kind: 'pr', number: 1, status }))).toBe(false);
    }
  });
});

describe('isMarked', () => {
  it('reflects is_marked verbatim', () => {
    expect(isMarked(mkItem({ kind: 'pr', number: 1, is_marked: true }))).toBe(true);
    expect(isMarked(mkItem({ kind: 'pr', number: 1, is_marked: false }))).toBe(false);
  });
});

describe('isVettedAwaitingDecision', () => {
  const vetted = {
    vetted_score: 250,
    source: 'agent' as const,
    notes: '',
    vetted_at: '2026-05-29T12:00:00.000Z' as const,
  };
  it('true when triage_assessment is set AND slung is null', () => {
    expect(
      isVettedAwaitingDecision(
        mkItem({ kind: 'pr', number: 1, triage_assessment: vetted, slung: null }),
      ),
    ).toBe(true);
  });
  it('false when slung is non-null (still in flight)', () => {
    expect(
      isVettedAwaitingDecision(
        mkItem({
          kind: 'pr',
          number: 1,
          triage_assessment: vetted,
          slung: {
            slung_at: NOW_ISO,
            target: 'chief-of-staff',
            bead_id: null,
            resolved_session_name: null,
          },
        }),
      ),
    ).toBe(false);
  });
  it('false when triage_assessment is null', () => {
    expect(
      isVettedAwaitingDecision(
        mkItem({ kind: 'pr', number: 1, triage_assessment: null, slung: null }),
      ),
    ).toBe(false);
  });
});

describe('isStalledUnvetted', () => {
  const vetted = {
    vetted_score: 250,
    source: 'agent' as const,
    notes: '',
    vetted_at: '2026-05-29T12:00:00.000Z' as const,
  };

  it('true when updated_at is older than the threshold AND not vetted AND not slung', () => {
    const oldIso = new Date(
      NOW_MS - (NEEDS_YOU_STALL_THRESHOLD_DAYS + 1) * ONE_DAY_MS,
    ).toISOString();
    expect(isStalledUnvetted(mkItem({ kind: 'pr', number: 1, updated_at: oldIso }), NOW_MS)).toBe(
      true,
    );
  });

  it('false when fresher than the threshold', () => {
    const freshIso = new Date(
      NOW_MS - (NEEDS_YOU_STALL_THRESHOLD_DAYS - 1) * ONE_DAY_MS,
    ).toISOString();
    expect(isStalledUnvetted(mkItem({ kind: 'pr', number: 1, updated_at: freshIso }), NOW_MS)).toBe(
      false,
    );
  });

  it('false at exactly the threshold (strict >, not >=)', () => {
    // "older than 7 days" means strictly past the boundary. An item
    // touched exactly 7d ago is at the boundary, not yet stalled.
    const boundaryIso = new Date(
      NOW_MS - NEEDS_YOU_STALL_THRESHOLD_DAYS * ONE_DAY_MS,
    ).toISOString();
    expect(
      isStalledUnvetted(mkItem({ kind: 'pr', number: 1, updated_at: boundaryIso }), NOW_MS),
    ).toBe(false);
  });

  it('false when vetted (an agent vetted it; staleness is no longer the operator signal)', () => {
    const oldIso = new Date(
      NOW_MS - (NEEDS_YOU_STALL_THRESHOLD_DAYS + 1) * ONE_DAY_MS,
    ).toISOString();
    expect(
      isStalledUnvetted(
        mkItem({ kind: 'pr', number: 1, updated_at: oldIso, triage_assessment: vetted }),
        NOW_MS,
      ),
    ).toBe(false);
  });

  it('false when in-flight (slung; the operator is already waiting on an agent)', () => {
    const oldIso = new Date(
      NOW_MS - (NEEDS_YOU_STALL_THRESHOLD_DAYS + 1) * ONE_DAY_MS,
    ).toISOString();
    expect(
      isStalledUnvetted(
        mkItem({
          kind: 'pr',
          number: 1,
          updated_at: oldIso,
          slung: {
            slung_at: NOW_ISO,
            target: 'chief-of-staff',
            bead_id: null,
            resolved_session_name: null,
          },
        }),
        NOW_MS,
      ),
    ).toBe(false);
  });

  it('accepts a Date for `now` as well as a number', () => {
    const oldIso = new Date(
      NOW_MS - (NEEDS_YOU_STALL_THRESHOLD_DAYS + 1) * ONE_DAY_MS,
    ).toISOString();
    expect(
      isStalledUnvetted(mkItem({ kind: 'pr', number: 1, updated_at: oldIso }), new Date(NOW_MS)),
    ).toBe(true);
  });

  it('false on malformed `updated_at` (Date.parse → NaN) — fail closed, do not surface as stalled', () => {
    expect(
      isStalledUnvetted(mkItem({ kind: 'pr', number: 1, updated_at: 'not-a-date' }), NOW_MS),
    ).toBe(false);
  });
});

describe('isNeedsYou (composite OR over the six documented clauses)', () => {
  it('true when ANY clause is true: changes_requested', () => {
    expect(isNeedsYou(mkItem({ kind: 'pr', number: 1, status: 'changes_requested' }), NOW_MS)).toBe(
      true,
    );
  });
  it('true when ANY clause is true: needs_review', () => {
    expect(isNeedsYou(mkItem({ kind: 'pr', number: 1, status: 'needs_review' }), NOW_MS)).toBe(
      true,
    );
  });
  it('true when ANY clause is true: approved PR (human-approval gate)', () => {
    expect(isNeedsYou(mkItem({ kind: 'pr', number: 1, status: 'approved' }), NOW_MS)).toBe(true);
  });
  it('true when ANY clause is true: is_marked issue', () => {
    expect(isNeedsYou(mkItem({ kind: 'issue', number: 1, is_marked: true }), NOW_MS)).toBe(true);
  });
  it('true when ANY clause is true: vetted, awaiting decision', () => {
    const vetted = {
      vetted_score: 250,
      source: 'agent' as const,
      notes: '',
      vetted_at: '2026-05-29T12:00:00.000Z' as const,
    };
    expect(
      isNeedsYou(mkItem({ kind: 'pr', number: 1, triage_assessment: vetted, slung: null }), NOW_MS),
    ).toBe(true);
  });
  it('true when ANY clause is true: stalled and unvetted', () => {
    const oldIso = new Date(NOW_MS - 10 * ONE_DAY_MS).toISOString();
    expect(isNeedsYou(mkItem({ kind: 'pr', number: 1, updated_at: oldIso }), NOW_MS)).toBe(true);
  });
  it('false for an item that satisfies NO clause (fresh, vetted-and-slung, not marked)', () => {
    const slung = {
      slung_at: NOW_ISO,
      target: 'chief-of-staff',
      bead_id: null,
      resolved_session_name: null,
    };
    expect(
      isNeedsYou(
        mkItem({
          kind: 'pr',
          number: 1,
          status: 'open',
          is_marked: false,
          slung,
          updated_at: NOW_ISO,
        }),
        NOW_MS,
      ),
    ).toBe(false);
  });
});

describe('filterTierByNeedsYou', () => {
  const vetted = {
    vetted_score: 250,
    source: 'agent' as const,
    notes: '',
    vetted_at: '2026-05-29T12:00:00.000Z' as const,
  };

  function tier(
    items: ReadonlyArray<{
      where: 'cluster' | 'unclustered';
      cluster?: string;
      item: TriageItem;
    }>,
  ): TriageTierSection {
    const unclustered = items.filter((x) => x.where === 'unclustered').map((x) => x.item);
    const clustered = items.filter((x) => x.where === 'cluster');
    const byCluster = new Map<string, TriageItem[]>();
    for (const x of clustered) {
      const key = x.cluster ?? 'c1';
      const bucket = byCluster.get(key) ?? [];
      bucket.push(x.item);
      byCluster.set(key, bucket);
    }
    return {
      tier: 'regression_breaking',
      clusters: Array.from(byCluster.entries()).map(([cluster_id, clusterItems]) => ({
        cluster_id,
        files: [`src/${cluster_id}.ts`],
        items: clusterItems,
        lines_pending: clusterItems.map((it) => it.lines_changed ?? 0).reduce((a, b) => a + b, 0),
      })),
      unclustered,
    };
  }

  it('keeps only needs-you items in both clusters and unclustered', () => {
    const keep1 = mkItem({ kind: 'pr', number: 1, status: 'changes_requested' });
    const keep2 = mkItem({ kind: 'pr', number: 2, status: 'approved' });
    const drop = mkItem({ kind: 'pr', number: 3, status: 'open', updated_at: NOW_ISO });
    const result = filterTierByNeedsYou(
      tier([
        { where: 'cluster', item: keep1 },
        { where: 'cluster', item: drop },
        { where: 'unclustered', item: keep2 },
      ]),
      NOW_MS,
    );
    expect(result.clusters.flatMap((c) => c.items.map((i) => i.number))).toEqual([1]);
    expect(result.unclustered.map((i) => i.number)).toEqual([2]);
  });

  it('drops clusters that become empty after filtering', () => {
    const dropOnly = mkItem({ kind: 'pr', number: 1, status: 'open', updated_at: NOW_ISO });
    const result = filterTierByNeedsYou(tier([{ where: 'cluster', item: dropOnly }]), NOW_MS);
    expect(result.clusters).toEqual([]);
  });

  it('preserves tier field, cluster_id, files, and lines_pending (pass-through, not recomputed)', () => {
    const keep = mkItem({
      kind: 'pr',
      number: 1,
      status: 'changes_requested',
      lines_changed: 30,
    });
    const drop = mkItem({
      kind: 'pr',
      number: 2,
      status: 'open',
      updated_at: NOW_ISO,
      lines_changed: 70,
    });
    const input = tier([
      { where: 'cluster', item: keep },
      { where: 'cluster', item: drop },
    ]);
    // Input lines_pending sums BOTH items (100); filter must NOT recompute
    // it to the surviving-items-only sum (30) — the field is a stable
    // tier-level metric in the wire envelope.
    const inputLinesPending = input.clusters[0]?.lines_pending;
    const result = filterTierByNeedsYou(input, NOW_MS);
    expect(result.tier).toBe('regression_breaking');
    expect(result.clusters[0]?.cluster_id).toBe('c1');
    expect(result.clusters[0]?.files).toEqual(['src/c1.ts']);
    expect(result.clusters[0]?.lines_pending).toBe(inputLinesPending);
  });

  it('keeps surviving clusters and drops fully-empty ones (multi-cluster)', () => {
    const keep = mkItem({ kind: 'pr', number: 1, status: 'changes_requested' });
    const drop1 = mkItem({ kind: 'pr', number: 2, status: 'open', updated_at: NOW_ISO });
    const drop2 = mkItem({ kind: 'pr', number: 3, status: 'open', updated_at: NOW_ISO });
    const input = tier([
      { where: 'cluster', cluster: 'c1', item: keep },
      { where: 'cluster', cluster: 'c1', item: drop1 },
      { where: 'cluster', cluster: 'c2', item: drop2 },
    ]);
    const result = filterTierByNeedsYou(input, NOW_MS);
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]?.cluster_id).toBe('c1');
    expect(result.clusters[0]?.items.map((i) => i.number)).toEqual([1]);
  });

  it('returns an immutable copy — does not mutate the input section', () => {
    const keep = mkItem({ kind: 'pr', number: 1, status: 'changes_requested' });
    const drop = mkItem({ kind: 'pr', number: 2, status: 'open', updated_at: NOW_ISO });
    const input = tier([
      { where: 'cluster', item: keep },
      { where: 'cluster', item: drop },
    ]);
    const before = input.clusters[0]?.items.length;
    filterTierByNeedsYou(input, NOW_MS);
    expect(input.clusters[0]?.items.length).toBe(before);
  });

  it('a vetted item with non-null slung does NOT survive (operator is already waiting)', () => {
    const slung = {
      slung_at: NOW_ISO,
      target: 'chief-of-staff',
      bead_id: null,
      resolved_session_name: null,
    };
    const dropped = mkItem({
      kind: 'pr',
      number: 1,
      status: 'open',
      triage_assessment: vetted,
      slung,
    });
    const result = filterTierByNeedsYou(tier([{ where: 'unclustered', item: dropped }]), NOW_MS);
    expect(result.unclustered).toEqual([]);
  });
});
