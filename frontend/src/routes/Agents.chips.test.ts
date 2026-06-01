import { describe, expect, it } from 'vitest';
import type { GcAgent } from 'gas-city-dashboard-shared';
import { buildAgentSynopsis, stateTone } from './Agents';

// gascity-dashboard-ay6: the Agents view consumes the supervisor's
// first-class agent roster (GcAgent), not the session list. These tests
// pin the state→tone and synopsis-count contracts the table still relies
// on for the State column and the page synopsis line.

function mkAgent(state: string, overrides: Partial<GcAgent> = {}): GcAgent {
  return {
    name: `agent-${state}`,
    available: true,
    running: state === 'active' || state === 'running',
    suspended: false,
    state,
    ...overrides,
  };
}

describe('stateTone', () => {
  it('classifies detached agents explicitly (not via default fallthrough)', () => {
    // Detached is paused-alive — same neutral palette as idle/asleep, but the
    // case is explicit so a reviewer sees the intent rather than a silent
    // default. See gascity-dashboard-x4k for context.
    expect(stateTone('detached')).toBe('neutral');
  });

  it('falls through to neutral for unknown states', () => {
    // AgentResponse.state is free `string` for forward-compat. Any state
    // gc emits that the dashboard hasn't seen yet must land on neutral
    // via the default branch — not crash, not lie with a tone we picked
    // at random.
    expect(stateTone('this-state-does-not-exist')).toBe('neutral');
  });
});

describe('buildAgentSynopsis', () => {
  it('reports detached agents as a distinct count, not bucketed under idle', () => {
    const rows: GcAgent[] = [
      mkAgent('active'),
      mkAgent('asleep'),
      mkAgent('asleep'),
      mkAgent('detached'),
    ];
    const synopsis = buildAgentSynopsis(rows);
    expect(synopsis).toContain('1 active');
    expect(synopsis).toContain('2 idle');
    expect(synopsis).toContain('1 detached');
  });

  it('omits detached from the synopsis when there are no detached agents', () => {
    const rows: GcAgent[] = [mkAgent('active'), mkAgent('asleep')];
    expect(buildAgentSynopsis(rows)).not.toContain('detached');
  });

  it('breaks suspended out as its own count', () => {
    const rows: GcAgent[] = [
      mkAgent('active'),
      mkAgent('asleep', { suspended: true }),
    ];
    expect(buildAgentSynopsis(rows)).toContain('1 suspended');
  });

  it('returns the empty-state sentence when no rows', () => {
    expect(buildAgentSynopsis([])).toBe('No agents configured.');
  });
});
