import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TriageItem, TriageTierSection } from 'gas-city-dashboard-shared';
import type { ReactElement } from 'react';
import { NowProvider } from '../../../contexts/NowContext';
import { IssueRow, TierSection } from './TriageSections';

const FIXED_ISO = '2026-05-27T00:00:00.000Z';

function item(
  overrides: Partial<TriageItem> & { kind: 'issue' | 'pr'; number: number },
): TriageItem {
  return {
    kind: overrides.kind,
    number: overrides.number,
    title: overrides.title ?? `Item ${overrides.number}`,
    status: overrides.status ?? 'open',
    author: overrides.author ?? {
      login: 'someone',
      tier: 'regular',
      issues_accepted: null,
      issues_opened: null,
      prs_merged: null,
      prs_opened: null,
      computed_at: null,
    },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    labels: overrides.labels ?? [],
    tier: overrides.tier ?? 'stability',
    triage_score: overrides.triage_score ?? null,
    triage_assessment: overrides.triage_assessment ?? null,
    slung: overrides.slung ?? null,
    cluster_id: overrides.cluster_id ?? null,
    blast_files: overrides.blast_files ?? [],
    lines_changed: overrides.lines_changed ?? null,
    weak_ties: overrides.weak_ties ?? [],
    linked_numbers: overrides.linked_numbers ?? [],
    html_url: overrides.html_url ?? `https://example.test/${overrides.number}`,
    is_marked: overrides.is_marked ?? false,
    has_in_flight_pr: overrides.has_in_flight_pr ?? false,
  };
}

describe('maintainer triage sections', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function renderWithNow(ui: ReactElement, now = '2026-05-28T00:00:00.000Z') {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    return render(<NowProvider intervalMs={60_000}>{ui}</NowProvider>);
  }

  it('renders tier counts and item count from a standalone component module', () => {
    const section: TriageTierSection = {
      tier: 'regression_breaking',
      clusters: [],
      unclustered: [item({ kind: 'issue', number: 1 })],
    };

    renderWithNow(
      <TierSection
        section={section}
        counts={{ vetted: 2, awaiting: 3 }}
        collapsed={false}
        onToggle={() => {}}
        isCollapsed={() => false}
        toggleCluster={() => {}}
        selection={new Set()}
        onToggleSelect={null}
      />,
    );

    expect(screen.getByText(/Regression \+ breaking/i)).toBeTruthy();
    const countMatches = screen.getAllByText((_text, element) => {
      const normalized = element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      return normalized.includes('2 vetted · 3 awaiting');
    });
    expect(countMatches.length).toBeGreaterThan(0);
    expect(screen.getByText(/1 item/i)).toBeTruthy();
  });

  it('shows "N of M items" when a filter is active (filtered count differs from unfiltered)', () => {
    const section: TriageTierSection = {
      tier: 'regression_breaking',
      clusters: [],
      unclustered: [item({ kind: 'issue', number: 1 })],
    };

    renderWithNow(
      <TierSection
        section={section}
        counts={{ vetted: 2, awaiting: 3 }}
        unfilteredItemCount={5}
        collapsed={false}
        onToggle={() => {}}
        isCollapsed={() => false}
        toggleCluster={() => {}}
        selection={new Set()}
        onToggleSelect={null}
      />,
    );

    expect(screen.getByText(/1 of 5 items/i)).toBeTruthy();
  });

  it('still renders plain "N items" when unfilteredItemCount equals the rendered count', () => {
    const section: TriageTierSection = {
      tier: 'regression_breaking',
      clusters: [],
      unclustered: [item({ kind: 'issue', number: 1 }), item({ kind: 'issue', number: 2 })],
    };

    renderWithNow(
      <TierSection
        section={section}
        counts={{ vetted: 0, awaiting: 2 }}
        unfilteredItemCount={2}
        collapsed={false}
        onToggle={() => {}}
        isCollapsed={() => false}
        toggleCluster={() => {}}
        selection={new Set()}
        onToggleSelect={null}
      />,
    );

    expect(screen.getByText(/2 items/i)).toBeTruthy();
    expect(screen.queryByText(/of 2 items/i)).toBeNull();
  });

  it('renders issue row policy without importing the route module', () => {
    renderWithNow(
      <IssueRow
        item={item({ kind: 'issue', number: 42, title: 'Fix active run display' })}
        hasInListChildren={false}
        selection={new Set()}
        onToggleSelect={null}
      />,
    );

    expect(screen.getByText('Fix active run display')).toBeTruthy();
    expect(screen.getByText(/needs PR/i)).toBeTruthy();
  });

  it('uses the shared 24h relative-age boundary for row timestamps', () => {
    renderWithNow(
      <IssueRow
        item={item({
          kind: 'issue',
          number: 43,
          title: 'Fix stale age grammar',
          updated_at: '2026-05-27T00:00:00.000Z',
        })}
        hasInListChildren={false}
        selection={new Set()}
        onToggleSelect={null}
      />,
    );

    expect(screen.getByText('1d')).toBeTruthy();
    expect(screen.queryByText('24h')).toBeNull();
  });
});
