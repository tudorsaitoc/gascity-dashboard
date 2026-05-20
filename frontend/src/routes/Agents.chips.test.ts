import { describe, expect, it } from 'vitest';
import type { GcSession } from 'gas-city-dashboard-shared';
import { SESSION_CHIPS } from './Agents';

// Every named value in GcSessionState (shared/src/index.ts) must match
// at least one chip. Otherwise, sessions in that state vanish silently
// when any chip is active — the bug from gascity-dashboard-9yb. Listed
// literally rather than via Exclude<GcSessionState, string> because the
// union widens to string for forward-compat, which would yield never.
const NAMED_STATES = [
  'creating',
  'active',
  'asleep',
  'detached',
  'failed',
  'closed',
] as const;

function mkSession(state: string): GcSession {
  return {
    id: `s-${state}`,
    template: 'claude-code',
    state,
    created_at: '2026-01-01T00:00:00Z',
    attached: false,
  };
}

describe('SESSION_CHIPS', () => {
  it('every named GcSessionState matches at least one chip', () => {
    for (const state of NAMED_STATES) {
      const session = mkSession(state);
      const matched = SESSION_CHIPS.some((chip) => chip.match(session));
      expect(
        matched,
        `state "${state}" must match at least one chip, otherwise it disappears when any chip is active`,
      ).toBe(true);
    }
  });

  it('exposes a "detached" chip so detached sessions stay visible under chip filters', () => {
    const detached = mkSession('detached');
    const detachedChip = SESSION_CHIPS.find((chip) => chip.id === 'detached');
    expect(detachedChip, 'detached chip should exist').toBeDefined();
    expect(detachedChip?.match(detached)).toBe(true);
  });

  it('detached sessions match only the detached chip when not running', () => {
    const detached = mkSession('detached');
    const matchingIds = SESSION_CHIPS.filter((chip) => chip.match(detached)).map(
      (chip) => chip.id,
    );
    expect(matchingIds).toEqual(['detached']);
  });
});
