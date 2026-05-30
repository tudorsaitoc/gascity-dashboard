import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TriageItem, TriageTierSection } from 'gas-city-dashboard-shared';
import { IssueRow, filterTierByNeedsPr } from './Maintainer';

// gascity-dashboard-omv: render-level coverage for the issue-row
// "needs PR" indicator + the "Needs PR only" filter helper.
//
// The indicator is a quiet uppercase-tracked label rendered on issue
// rows where `has_in_flight_pr === false`. It reads in the same
// register as the existing "anchored" label.
//
// The filter helper (filterTierByNeedsPr) is a pure transform on a
// TriageTierSection: it returns a section containing ONLY issue items
// where `has_in_flight_pr === false`, with PRs dropped entirely (the
// filter is issue-focused per the bead).

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

describe('IssueRow — needs-PR indicator', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the "needs PR" label when has_in_flight_pr is false', () => {
    const item = mkItem({
      kind: 'issue',
      number: 42,
      has_in_flight_pr: false,
    });
    render(
      <IssueRow
        item={item}
        hasInListChildren={false}
        selection={new Set()}
        onToggleSelect={null}
      />,
    );
    expect(screen.getByText(/needs PR/i)).toBeTruthy();
  });

  it('does NOT render "needs PR" when has_in_flight_pr is true', () => {
    const item = mkItem({
      kind: 'issue',
      number: 42,
      has_in_flight_pr: true,
    });
    render(
      <IssueRow
        item={item}
        hasInListChildren={false}
        selection={new Set()}
        onToggleSelect={null}
      />,
    );
    expect(screen.queryByText(/needs PR/i)).toBeNull();
  });

  it('renders "needs PR" even when the issue has linked PR numbers, as long as none are in-flight', () => {
    // Reverse-mapped linked_numbers can include closed PRs that the
    // backend correctly marked has_in_flight_pr=false. The frontend
    // must trust the backend signal, not re-derive from linked_numbers.
    const item = mkItem({
      kind: 'issue',
      number: 42,
      linked_numbers: [99],
      has_in_flight_pr: false,
    });
    render(
      <IssueRow
        item={item}
        hasInListChildren={false}
        selection={new Set()}
        onToggleSelect={null}
      />,
    );
    expect(screen.getByText(/needs PR/i)).toBeTruthy();
  });

});

describe('filterTierByNeedsPr — pure filter helper', () => {
  function mkSection(items: TriageItem[]): TriageTierSection {
    return {
      tier: 'regression_breaking',
      clusters: [],
      unclustered: items,
    };
  }

  it('keeps only issues with has_in_flight_pr=false in unclustered', () => {
    const a = mkItem({ kind: 'issue', number: 1, has_in_flight_pr: false });
    const b = mkItem({ kind: 'issue', number: 2, has_in_flight_pr: true });
    const filtered = filterTierByNeedsPr(mkSection([a, b]));
    expect(filtered.unclustered.map((i) => i.number)).toEqual([1]);
  });

  it('drops PR items entirely (the filter is issue-focused)', () => {
    const issue = mkItem({ kind: 'issue', number: 1, has_in_flight_pr: false });
    const pr = mkItem({ kind: 'pr', number: 2 });
    const filtered = filterTierByNeedsPr(mkSection([issue, pr]));
    expect(filtered.unclustered.map((i) => `${i.kind}:${i.number}`)).toEqual(['issue:1']);
  });

  it('filters each cluster independently and drops clusters that become empty', () => {
    const issueKeep = mkItem({ kind: 'issue', number: 1, has_in_flight_pr: false });
    const issueDrop = mkItem({ kind: 'issue', number: 2, has_in_flight_pr: true });
    const pr = mkItem({ kind: 'pr', number: 3 });
    const section: TriageTierSection = {
      tier: 'regression_breaking',
      clusters: [
        {
          cluster_id: 'c1',
          files: ['a.ts'],
          items: [issueKeep, pr],
          lines_pending: 0,
        },
        {
          cluster_id: 'c2',
          files: ['b.ts'],
          items: [issueDrop, pr],
          lines_pending: 0,
        },
      ],
      unclustered: [],
    };
    const filtered = filterTierByNeedsPr(section);
    expect(filtered.clusters.length).toBe(1);
    expect(filtered.clusters[0]?.cluster_id).toBe('c1');
    expect(filtered.clusters[0]?.items.map((i) => i.number)).toEqual([1]);
  });

  it('returns a tier with empty unclustered + empty clusters when nothing needs a PR', () => {
    const a = mkItem({ kind: 'issue', number: 1, has_in_flight_pr: true });
    const b = mkItem({ kind: 'pr', number: 2 });
    const filtered = filterTierByNeedsPr(mkSection([a, b]));
    expect(filtered.unclustered).toEqual([]);
    expect(filtered.clusters).toEqual([]);
  });

  it('preserves tier identity (regression vs regression_breaking vs stability)', () => {
    const a = mkItem({ kind: 'issue', number: 1, has_in_flight_pr: false });
    const section: TriageTierSection = {
      tier: 'regression',
      clusters: [],
      unclustered: [a],
    };
    const filtered = filterTierByNeedsPr(section);
    expect(filtered.tier).toBe('regression');
  });

  it('preserves cluster metadata (files, cluster_id, lines_pending) on surviving clusters', () => {
    const a = mkItem({ kind: 'issue', number: 1, has_in_flight_pr: false });
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
    const filtered = filterTierByNeedsPr(section);
    expect(filtered.clusters[0]?.files).toEqual(['a.ts', 'b.ts']);
    expect(filtered.clusters[0]?.cluster_id).toBe('c1');
    expect(filtered.clusters[0]?.lines_pending).toBe(42);
  });
});
