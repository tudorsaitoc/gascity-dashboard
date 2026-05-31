import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { LaneCard } from './LaneCard';
import type { RunLane } from 'gas-city-dashboard-shared';

afterEach(() => cleanup());

describe('LaneCard navigation', () => {
  it('links run rows to the run detail route with scope query params', () => {
    const lane: RunLane = {
      id: 'gc-root',
      title: 'Adopt PR #42',
      formula: { status: 'known', name: 'mol-adopt-pr-v2' },
      scope: {
        status: 'available',
        kind: 'city',
        ref: 'racoon-city',
        rootStoreRef: 'city:racoon-city',
      },
      external: { status: 'unavailable', error: 'external unavailable in test' },
      phase: 'review',
      phaseLabel: 'review',
      statusCounts: { in_progress: 1 },
      activeAssignees: ['gc-session-b'],
      updatedAt: {
        status: 'available',
        at: '2026-05-24T12:00:00Z',
      },
      stages: [],
      progress: {
        status: 'unavailable',
        error: 'run progress unavailable in test',
      },
      formulaStageResolved: false,
      health: { status: 'unavailable', error: 'run health has not been derived' },
    };

    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <LaneCard lane={lane} now={Date.parse('2026-05-24T12:01:00Z')} />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: /adopt pr #42/i });
    expect(link.getAttribute('href')).toBe(
      '/runs/gc-root?scope_kind=city&scope_ref=racoon-city',
    );
  });

  it('omits scope query params when the lane has unavailable scope', () => {
    const lane: RunLane = {
      id: 'gc-root',
      title: 'Adopt PR #42',
      formula: { status: 'known', name: 'mol-adopt-pr-v2' },
      scope: { status: 'unavailable', error: 'scope unavailable in test' },
      external: { status: 'unavailable', error: 'external unavailable in test' },
      phase: 'review',
      phaseLabel: 'review',
      statusCounts: { in_progress: 1 },
      activeAssignees: ['gc-session-b'],
      updatedAt: {
        status: 'available',
        at: '2026-05-24T12:00:00Z',
      },
      stages: [],
      progress: {
        status: 'unavailable',
        error: 'run progress unavailable in test',
      },
      formulaStageResolved: false,
      health: { status: 'unavailable', error: 'run health has not been derived' },
    };

    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <LaneCard lane={lane} now={Date.parse('2026-05-24T12:01:00Z')} />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: /adopt pr #42/i });
    expect(link.getAttribute('href')).toBe('/runs/gc-root');
  });
});
