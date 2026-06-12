import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyRunSummary, MAX_VISIBLE_ACTIVE_LANES } from 'gas-city-dashboard-shared';
import type { RunHistory, RunLane, RunSummary, SourceState } from 'gas-city-dashboard-shared';
import { RunMap } from './RunMap';

afterEach(() => cleanup());

function historicalLane(id: string): RunLane {
  return {
    id,
    title: `Completed run ${id}`,
    formula: { status: 'known', name: 'mol-focus-review' },
    scope: {
      status: 'available',
      kind: 'city',
      ref: 'racoon-city',
      rootStoreRef: 'city:racoon-city',
    },
    external: { status: 'unavailable', error: 'external unavailable in test' },
    phase: 'complete',
    phaseLabel: 'complete',
    statusCounts: { closed: 1 },
    activeAssignees: [],
    updatedAt: { status: 'available', at: '2026-05-24T12:00:00Z' },
    stages: [],
    progress: { status: 'unavailable', error: 'run progress unavailable in test' },
    formulaStageResolved: false,
    health: { status: 'unavailable', error: 'run health has not been derived' },
  };
}

function emptySummarySource(): SourceState<RunSummary> {
  return {
    source: 'runs',
    status: 'fresh',
    fetchedAt: '2026-05-24T12:00:00Z',
    staleAt: '2026-05-24T12:01:00Z',
    error: { kind: 'none' },
    data: emptyRunSummary(),
  };
}

// Header-first: history is its own lazy source rendered by RunMap's
// historical section, not a field on the run summary.
function historySource(
  lanes: RunLane[],
  totalHistorical = lanes.length,
  lanesPartial = false,
): SourceState<RunHistory> {
  return {
    source: 'runs',
    status: 'fresh',
    fetchedAt: '2026-05-24T12:00:00Z',
    staleAt: '2026-05-24T12:01:00Z',
    error: { kind: 'none' },
    data: {
      totalHistorical,
      lanes,
      ...(lanesPartial ? { lanesPartial: true } : {}),
    },
  };
}

function makeLanes(count: number): RunLane[] {
  return Array.from({ length: count }, (_, i) => historicalLane(`gc-hist-${i}`));
}

function renderHistory(lanes: RunLane[], totalHistorical?: number) {
  return renderHistorySource(historySource(lanes, totalHistorical));
}

function renderHistorySource(history: SourceState<RunHistory> | undefined, historyLoading = false) {
  return render(
    <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
      <RunMap
        source={emptySummarySource()}
        now={Date.parse('2026-05-24T12:01:00Z')}
        showHistory={true}
        history={history}
        historyLoading={historyLoading}
      />
    </MemoryRouter>,
  );
}

describe('RunMap historical expand-in-place (gascity-dashboard-l9q9)', () => {
  it('previews 5 lanes with a Show-more toggle instead of a static footnote', () => {
    const lanes = makeLanes(7);
    renderHistory(lanes);

    const section = screen.getByRole('region', { name: /historical runs/i });
    expect(within(section).getAllByRole('listitem')).toHaveLength(5);
    expect(screen.queryByText(/more not shown/i)).toBeNull();

    const toggle = within(section).getByRole('button', { name: /show 2 more/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('expands to all lanes in place and collapses back', () => {
    const lanes = makeLanes(7);
    renderHistory(lanes);

    const section = screen.getByRole('region', { name: /historical runs/i });
    fireEvent.click(within(section).getByRole('button', { name: /show 2 more/i }));

    expect(within(section).getAllByRole('listitem')).toHaveLength(7);
    const collapse = within(section).getByRole('button', { name: /show fewer/i });
    expect(collapse.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(collapse);
    expect(within(section).getAllByRole('listitem')).toHaveLength(5);
  });

  it('renders no toggle when the historical set fits the preview', () => {
    const lanes = makeLanes(5);
    renderHistory(lanes);

    const section = screen.getByRole('region', { name: /historical runs/i });
    expect(within(section).getAllByRole('listitem')).toHaveLength(5);
    expect(within(section).queryByRole('button')).toBeNull();
  });
});

function activeLane(id: string): RunLane {
  return {
    id,
    title: `Active run ${id}`,
    formula: { status: 'known', name: 'mol-adopt-pr-v2' },
    scope: {
      status: 'available',
      kind: 'city',
      ref: 'racoon-city',
      rootStoreRef: 'city:racoon-city',
    },
    external: { status: 'unavailable', error: 'external unavailable in test' },
    phase: 'implementation',
    phaseLabel: 'implementation',
    statusCounts: { in_progress: 1 },
    activeAssignees: [],
    updatedAt: { status: 'available', at: '2026-05-24T12:00:00Z' },
    stages: [],
    progress: { status: 'unavailable', error: 'run progress unavailable in test' },
    formulaStageResolved: false,
    health: { status: 'unavailable', error: 'run health has not been derived' },
  };
}

function makeActiveLanes(count: number): RunLane[] {
  return Array.from({ length: count }, (_, i) => activeLane(`gc-active-${i}`));
}

function renderActive(lanes: RunLane[]) {
  return render(
    <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
      <RunMap
        source={{
          source: 'runs',
          status: 'fresh',
          fetchedAt: '2026-05-24T12:00:00Z',
          staleAt: '2026-05-24T12:01:00Z',
          error: { kind: 'none' },
          data: { ...emptyRunSummary(), totalActive: lanes.length, lanes },
        }}
        now={Date.parse('2026-05-24T12:01:00Z')}
        showHistory={false}
      />
    </MemoryRouter>,
  );
}

describe('RunMap active expand-in-place (lane-cap expander)', () => {
  it('collapses to MAX_VISIBLE_ACTIVE_LANES with a Show-more toggle, no static footnote', () => {
    const lanes = makeActiveLanes(MAX_VISIBLE_ACTIVE_LANES + 1);
    renderActive(lanes);

    expect(screen.getAllByRole('listitem')).toHaveLength(MAX_VISIBLE_ACTIVE_LANES);
    expect(screen.queryByText(/more not shown/i)).toBeNull();

    const toggle = screen.getByRole('button', { name: /show 1 more runs/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('expands to all active lanes in place and collapses back', () => {
    const total = MAX_VISIBLE_ACTIVE_LANES + 1;
    const lanes = makeActiveLanes(total);
    renderActive(lanes);

    fireEvent.click(screen.getByRole('button', { name: /show 1 more runs/i }));
    expect(screen.getAllByRole('listitem')).toHaveLength(total);

    const collapse = screen.getByRole('button', { name: /show fewer/i });
    expect(collapse.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(collapse);
    expect(screen.getAllByRole('listitem')).toHaveLength(MAX_VISIBLE_ACTIVE_LANES);
  });

  it('renders no toggle when the active set fits the collapsed window', () => {
    renderActive(makeActiveLanes(MAX_VISIBLE_ACTIVE_LANES));

    expect(screen.getAllByRole('listitem')).toHaveLength(MAX_VISIBLE_ACTIVE_LANES);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('drives the expander off the RENDERED lane count, not totalActive', () => {
    // Self-consistency guard (mirrors the Historical section): the toggle's
    // visibility AND its "N more" label both derive from summary.lanes.length —
    // the collection actually rendered — not from totalActive. Feed a totalActive
    // that disagrees with the lane count to prove the dependency is gone.
    const lanes = makeActiveLanes(MAX_VISIBLE_ACTIVE_LANES + 2);
    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <RunMap
          source={{
            source: 'runs',
            status: 'fresh',
            fetchedAt: '2026-05-24T12:00:00Z',
            staleAt: '2026-05-24T12:01:00Z',
            error: { kind: 'none' },
            // totalActive deliberately disagrees with lanes.length.
            data: { ...emptyRunSummary(), totalActive: 999, lanes },
          }}
          now={Date.parse('2026-05-24T12:01:00Z')}
          showHistory={false}
        />
      </MemoryRouter>,
    );

    // Label reads lanes.length - MAX_VISIBLE (2), NOT totalActive - MAX_VISIBLE.
    expect(screen.getByRole('button', { name: /show 2 more runs/i })).toBeTruthy();
  });
});

describe('RunMap historical recency-cap disclosure (gascity-dashboard-9w3k)', () => {
  it('discloses the cap when totalHistorical exceeds the rendered lane count', () => {
    // The wire caps historicalLanes at MAX_HISTORICAL_LANES but totalHistorical
    // reports the true completed count, so the section must say it is a window.
    const lanes = makeLanes(50);
    renderHistory(lanes, 60);

    const section = screen.getByRole('region', { name: /historical runs/i });
    expect(within(section).getByText(/showing 50 most-recent of 60/i)).toBeTruthy();
  });

  it('omits the disclosure when the full history fits the wire', () => {
    const lanes = makeLanes(7);
    renderHistory(lanes);

    const section = screen.getByRole('region', { name: /historical runs/i });
    expect(within(section).queryByText(/most-recent of/i)).toBeNull();
  });
});

// Header-first: the historical section owns its lazy source's loading /
// unavailable / partial states, so the operator always knows whether an empty
// section means "no completed runs", "still fetching", or "could not read".
describe('RunMap historical lazy-source states (header-first)', () => {
  it('shows a loading state before the first history read lands', () => {
    renderHistorySource(undefined, true);

    const section = screen.getByRole('region', { name: /historical runs/i });
    expect(within(section).getByText(/Loading completed runs\./i)).toBeTruthy();
    expect(within(section).queryByRole('listitem')).toBeNull();
  });

  it('shows an unavailable state when the history read failed', () => {
    renderHistorySource({
      source: 'runs',
      status: 'error',
      error: 'gc supervisor request timed out after 30000ms',
    });

    const section = screen.getByRole('region', { name: /historical runs/i });
    expect(
      within(section).getByText(
        /Completed runs unavailable: gc supervisor request timed out after 30000ms\./i,
      ),
    ).toBeTruthy();
  });

  it('renders the loading state while a retry is in flight after an error', () => {
    renderHistorySource(
      { source: 'runs', status: 'error', error: 'transient timeout' },
      true,
    );

    const section = screen.getByRole('region', { name: /historical runs/i });
    expect(within(section).getByText(/Loading completed runs\./i)).toBeTruthy();
  });

  it('pairs a history-partial notice with the lanes when the fan-out degraded', () => {
    renderHistorySource(historySource(makeLanes(2), 2, true));

    const section = screen.getByRole('region', { name: /historical runs/i });
    const marker = within(section).getByRole('status');
    expect(marker.textContent).toContain('◐');
    expect(marker.textContent).toContain('history partial');
    // The lanes still render alongside the degradation signal.
    expect(within(section).getAllByRole('listitem')).toHaveLength(2);
  });

  it('omits the partial notice on a clean history read', () => {
    renderHistory(makeLanes(2));

    const section = screen.getByRole('region', { name: /historical runs/i });
    expect(within(section).queryByRole('status')).toBeNull();
  });

  it('says so when a clean history read finds no completed runs', () => {
    renderHistory([]);

    const section = screen.getByRole('region', { name: /historical runs/i });
    expect(within(section).getByText(/No completed runs in the current window\./i)).toBeTruthy();
  });
});
