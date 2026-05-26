import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { LaneCard } from './LaneCard';
import type { WorkflowLane } from 'gas-city-dashboard-shared';

afterEach(() => cleanup());

describe('LaneCard navigation', () => {
  it('links workflow rows to the run detail route with scope query params', () => {
    const lane: WorkflowLane = {
      id: 'gc-root',
      title: 'Adopt PR #42',
      formula: 'mol-adopt-pr-v2',
      scopeKind: 'city',
      scopeRef: 'racoon-city',
      rootStoreRef: 'city:racoon-city',
      externalUrl: null,
      externalLabel: null,
      phase: 'review',
      phaseLabel: 'review',
      statusCounts: { in_progress: 1 },
      activeAssignees: ['gc-session-b'],
      updatedAt: '2026-05-24T12:00:00Z',
      stages: [],
      activeStepId: null,
      activeStepAttempt: null,
      activeStageIndex: null,
      formulaStageResolved: false,
    };

    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <LaneCard lane={lane} now={Date.parse('2026-05-24T12:01:00Z')} />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: /adopt pr #42/i });
    expect(link.getAttribute('href')).toBe(
      '/workflows/gc-root?scope_kind=city&scope_ref=racoon-city',
    );
  });

  it('omits scope query params when the lane has only half of the scope pair', () => {
    const lane: WorkflowLane = {
      id: 'gc-root',
      title: 'Adopt PR #42',
      formula: 'mol-adopt-pr-v2',
      scopeKind: undefined,
      scopeRef: 'racoon-city',
      rootStoreRef: 'city:racoon-city',
      externalUrl: null,
      externalLabel: null,
      phase: 'review',
      phaseLabel: 'review',
      statusCounts: { in_progress: 1 },
      activeAssignees: ['gc-session-b'],
      updatedAt: '2026-05-24T12:00:00Z',
      stages: [],
      activeStepId: null,
      activeStepAttempt: null,
      activeStageIndex: null,
      formulaStageResolved: false,
    };

    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <LaneCard lane={lane} now={Date.parse('2026-05-24T12:01:00Z')} />
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: /adopt pr #42/i });
    expect(link.getAttribute('href')).toBe('/workflows/gc-root');
  });
});
