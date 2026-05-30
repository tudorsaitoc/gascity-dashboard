import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  TriageAssessment,
  TriageItem,
  TriageTierSection,
} from 'gas-city-dashboard-shared';
import {
  TierSection,
  countTierByVetted,
  filterTierByAwaitingTriage,
} from './Maintainer';

// gascity-dashboard-x8q: render-level + helper coverage for the
// "Awaiting triage only" filter chip and the per-tier "N vetted ·
// M awaiting" counts.
//
// The chip is a sibling of focusBreaking (FOCUS_KEY) and needsPrOnly
// (NEEDS_PR_KEY): a typographic Button in the page-header meta strip
// that, when on, restricts every tier section to items where
// `triage_assessment === null`. The persistence is via localStorage
// under 'maintainer:awaitingOnly', same pattern as the siblings.
//
// The counts read in the same uppercase-tracked-faint register as the
// existing "N items" label on the right side of the tier header, in
// the form "N vetted · M awaiting" (interpunct per DESIGN.md). Counts
// are computed from the UNFILTERED tier so toggling the chip doesn't
// rewrite the counts.

function mkAssessment(score = 280): TriageAssessment {
  return {
    vetted_score: score,
    source: 'agent',
    notes: '',
    vetted_at: '2026-05-24T00:00:00.000Z',
  };
}

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
    linked_numbers: overrides.linked_numbers ?? [],
    weak_ties: overrides.weak_ties ?? [],
    created_at: overrides.created_at ?? '2026-05-20T00:00:00Z',
    updated_at: overrides.updated_at ?? '2026-05-22T00:00:00Z',
    has_in_flight_pr: overrides.has_in_flight_pr ?? false,
  };
}

describe('filterTierByAwaitingTriage — pure filter helper', () => {
  function mkSection(items: TriageItem[]): TriageTierSection {
    return {
      tier: 'regression_breaking',
      clusters: [],
      unclustered: items,
    };
  }

  it('keeps only items with triage_assessment=null in unclustered', () => {
    const awaiting = mkItem({ kind: 'issue', number: 1, triage_assessment: null });
    const vetted = mkItem({
      kind: 'issue',
      number: 2,
      triage_assessment: mkAssessment(),
    });
    const filtered = filterTierByAwaitingTriage(mkSection([awaiting, vetted]));
    expect(filtered.unclustered.map((i) => i.number)).toEqual([1]);
  });

  it('keeps both issue and pr kinds (the filter is kind-agnostic, vetted-only)', () => {
    const issueAwaiting = mkItem({ kind: 'issue', number: 1, triage_assessment: null });
    const prAwaiting = mkItem({ kind: 'pr', number: 2, triage_assessment: null });
    const issueVetted = mkItem({
      kind: 'issue',
      number: 3,
      triage_assessment: mkAssessment(),
    });
    const filtered = filterTierByAwaitingTriage(
      mkSection([issueAwaiting, prAwaiting, issueVetted]),
    );
    expect(filtered.unclustered.map((i) => `${i.kind}:${i.number}`)).toEqual([
      'issue:1',
      'pr:2',
    ]);
  });

  it('filters each cluster independently and drops clusters that become empty', () => {
    const keep = mkItem({ kind: 'issue', number: 1, triage_assessment: null });
    const drop = mkItem({
      kind: 'issue',
      number: 2,
      triage_assessment: mkAssessment(),
    });
    const section: TriageTierSection = {
      tier: 'regression_breaking',
      clusters: [
        {
          cluster_id: 'c1',
          files: ['a.ts'],
          items: [keep],
          lines_pending: 0,
        },
        {
          cluster_id: 'c2',
          files: ['b.ts'],
          items: [drop],
          lines_pending: 0,
        },
      ],
      unclustered: [],
    };
    const filtered = filterTierByAwaitingTriage(section);
    expect(filtered.clusters.length).toBe(1);
    expect(filtered.clusters[0]?.cluster_id).toBe('c1');
    expect(filtered.clusters[0]?.items.map((i) => i.number)).toEqual([1]);
  });

  it('returns a tier with empty unclustered + empty clusters when everything is vetted', () => {
    const a = mkItem({
      kind: 'issue',
      number: 1,
      triage_assessment: mkAssessment(),
    });
    const b = mkItem({
      kind: 'pr',
      number: 2,
      triage_assessment: mkAssessment(),
    });
    const filtered = filterTierByAwaitingTriage(mkSection([a, b]));
    expect(filtered.unclustered).toEqual([]);
    expect(filtered.clusters).toEqual([]);
  });

  it('preserves tier identity (regression vs regression_breaking vs stability)', () => {
    const a = mkItem({ kind: 'issue', number: 1, triage_assessment: null });
    const section: TriageTierSection = {
      tier: 'stability',
      clusters: [],
      unclustered: [a],
    };
    const filtered = filterTierByAwaitingTriage(section);
    expect(filtered.tier).toBe('stability');
  });

  it('preserves cluster metadata (files, cluster_id, lines_pending) on surviving clusters', () => {
    const a = mkItem({ kind: 'issue', number: 1, triage_assessment: null });
    const section: TriageTierSection = {
      tier: 'regression_breaking',
      clusters: [
        {
          cluster_id: 'c1',
          files: ['a.ts', 'b.ts'],
          items: [a],
          lines_pending: 42,
        },
      ],
      unclustered: [],
    };
    const filtered = filterTierByAwaitingTriage(section);
    expect(filtered.clusters[0]?.files).toEqual(['a.ts', 'b.ts']);
    expect(filtered.clusters[0]?.cluster_id).toBe('c1');
    expect(filtered.clusters[0]?.lines_pending).toBe(42);
  });
});

describe('countTierByVetted — vetted vs awaiting tally', () => {
  function mkSection(
    unclustered: TriageItem[],
    clusters: TriageTierSection['clusters'] = [],
  ): TriageTierSection {
    return { tier: 'regression_breaking', clusters, unclustered };
  }

  it('returns {vetted:0, awaiting:0} for an empty tier', () => {
    expect(countTierByVetted(mkSection([]))).toEqual({ vetted: 0, awaiting: 0 });
  });

  it('counts vetted as items where triage_assessment is not null', () => {
    const a = mkItem({
      kind: 'issue',
      number: 1,
      triage_assessment: mkAssessment(),
    });
    const b = mkItem({
      kind: 'pr',
      number: 2,
      triage_assessment: mkAssessment(),
    });
    expect(countTierByVetted(mkSection([a, b]))).toEqual({ vetted: 2, awaiting: 0 });
  });

  it('counts awaiting as items where triage_assessment is null', () => {
    const a = mkItem({ kind: 'issue', number: 1, triage_assessment: null });
    const b = mkItem({ kind: 'pr', number: 2, triage_assessment: null });
    expect(countTierByVetted(mkSection([a, b]))).toEqual({ vetted: 0, awaiting: 2 });
  });

  it('sums across clusters and unclustered', () => {
    const vetted = mkItem({
      kind: 'issue',
      number: 1,
      triage_assessment: mkAssessment(),
    });
    const awaiting1 = mkItem({ kind: 'issue', number: 2, triage_assessment: null });
    const awaiting2 = mkItem({ kind: 'pr', number: 3, triage_assessment: null });
    const section = mkSection(
      [vetted],
      [
        {
          cluster_id: 'c1',
          files: ['a.ts'],
          items: [awaiting1, awaiting2],
          lines_pending: 0,
        },
      ],
    );
    expect(countTierByVetted(section)).toEqual({ vetted: 1, awaiting: 2 });
  });
});

describe('TierSection — header counts render', () => {
  afterEach(() => {
    cleanup();
  });

  function mkSection(items: TriageItem[]): TriageTierSection {
    return { tier: 'regression_breaking', clusters: [], unclustered: items };
  }

  it('renders "N vetted · M awaiting" in the header when counts is provided', () => {
    const awaiting = mkItem({ kind: 'issue', number: 1, triage_assessment: null });
    const vetted = mkItem({
      kind: 'issue',
      number: 2,
      triage_assessment: mkAssessment(),
    });
    render(
      <TierSection
        section={mkSection([awaiting, vetted])}
        counts={{ vetted: 12, awaiting: 8 }}
        collapsed={false}
        onToggle={() => {}}
        isCollapsed={() => false}
        toggleCluster={() => {}}
        selection={new Set()}
        onToggleSelect={null}
      />,
    );
    // The counts line co-exists with the existing "N items" label. Use
    // a function matcher to handle the interpunct + whitespace.
    const matches = screen.getAllByText((_t, el) => {
      if (el === null) return false;
      const text = el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      return /12 vetted · 8 awaiting/.test(text);
    });
    expect(matches.length).toBeGreaterThan(0);
  });

  it('still renders counts when one side is zero (no special-case suppression)', () => {
    const vetted = mkItem({
      kind: 'issue',
      number: 1,
      triage_assessment: mkAssessment(),
    });
    render(
      <TierSection
        section={mkSection([vetted])}
        counts={{ vetted: 5, awaiting: 0 }}
        collapsed={false}
        onToggle={() => {}}
        isCollapsed={() => false}
        toggleCluster={() => {}}
        selection={new Set()}
        onToggleSelect={null}
      />,
    );
    const matches = screen.getAllByText((_t, el) => {
      if (el === null) return false;
      const text = el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      return /5 vetted · 0 awaiting/.test(text);
    });
    expect(matches.length).toBeGreaterThan(0);
  });

  it('counts reflect the unfiltered envelope: passing counts={vetted:12,awaiting:8} with a filtered (awaiting-only) section still renders "12 vetted · 8 awaiting"', () => {
    // This is the integration contract: the chip filters the rendered
    // items, but the header counts come from the unfiltered tier.
    const onlyAwaiting = mkItem({ kind: 'issue', number: 1, triage_assessment: null });
    render(
      <TierSection
        section={mkSection([onlyAwaiting])}
        counts={{ vetted: 12, awaiting: 8 }}
        collapsed={false}
        onToggle={() => {}}
        isCollapsed={() => false}
        toggleCluster={() => {}}
        selection={new Set()}
        onToggleSelect={null}
      />,
    );
    const matches = screen.getAllByText((_t, el) => {
      if (el === null) return false;
      const text = el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      return /12 vetted · 8 awaiting/.test(text);
    });
    expect(matches.length).toBeGreaterThan(0);
  });
});
