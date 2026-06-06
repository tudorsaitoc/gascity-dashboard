import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyRunSummary } from 'gas-city-dashboard-shared';
import type { RunLane, RunSummary, SourceState } from 'gas-city-dashboard-shared';
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

function runsSource(historicalLanes: RunLane[]): SourceState<RunSummary> {
  return {
    source: 'runs',
    status: 'fresh',
    fetchedAt: '2026-05-24T12:00:00Z',
    staleAt: '2026-05-24T12:01:00Z',
    error: { kind: 'none' },
    data: {
      ...emptyRunSummary(),
      totalHistorical: historicalLanes.length,
      historicalLanes,
    },
  };
}

function makeLanes(count: number): RunLane[] {
  return Array.from({ length: count }, (_, i) => historicalLane(`gc-hist-${i}`));
}

function renderHistory(historicalLanes: RunLane[]) {
  return render(
    <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
      <RunMap
        source={runsSource(historicalLanes)}
        now={Date.parse('2026-05-24T12:01:00Z')}
        showHistory={true}
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
