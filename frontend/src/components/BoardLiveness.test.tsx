import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceStatus } from 'gas-city-dashboard-shared';
import { BoardLiveness } from './BoardLiveness';
import { AttentionProvider } from '../attention/context';
import {
  ATTENTION_READ_STALE_AFTER_MS,
  type AttentionContributor,
  type AttentionDomain,
} from '../attention/compose';
import { NowProvider } from '../contexts/NowContext';
import type { GcEventConnState } from '../hooks/useGcEvents';

// The liveness line reads the gc event-stream state via useRunSummary. Drive it
// from a module-level var the single mock reads, so each test sets it without a
// re-stub (the unstubAll re-stub no-op gotcha).
let mockSseState: GcEventConnState = 'open';
vi.mock('../runs/runSummarySubscription', () => ({
  useRunSummary: () => ({ sseState: mockSseState }),
}));

// Pin the wall clock so age vs ATTENTION_READ_STALE_AFTER_MS is deterministic:
// the now()/secondsAgo()/minutesAgo() helpers below and NowProvider's initial
// Date.now() all read this fixed instant, so the tight now()->'all live' and
// secondsAgo(1)->'just now' windows can't drift toward the 90s stale boundary
// under CI load or clock skew (the repo's known silent-CI-red failure mode).
const FIXED_NOW = '2026-06-24T12:00:00.000Z';

beforeEach(() => {
  vi.useFakeTimers().setSystemTime(new Date(FIXED_NOW));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  mockSseState = 'open';
});

// Mirrors withReadFreshness: a landed (non-error) read carries a staleAt of
// fetchedAt + the stale window, so age-flip is driven by a real staleAt exactly
// as the polled domains do in production.
function freshContributor(
  domain: AttentionDomain,
  provenance: SourceStatus | undefined,
  fetchedAt: string | undefined,
): AttentionContributor {
  const staleAt =
    provenance !== 'error' && fetchedAt !== undefined
      ? new Date(Date.parse(fetchedAt) + ATTENTION_READ_STALE_AFTER_MS).toISOString()
      : undefined;
  return {
    id: `${domain}:test`,
    domain,
    getItems: () => [],
    ...(provenance !== undefined && { provenance }),
    ...(fetchedAt !== undefined && { fetchedAt }),
    ...(staleAt !== undefined && { staleAt }),
  };
}

function renderLiveness(contributors: readonly AttentionContributor[]) {
  return render(
    <NowProvider>
      <AttentionProvider contributors={contributors}>
        <BoardLiveness />
      </AttentionProvider>
    </NowProvider>,
  );
}

const now = () => new Date().toISOString();
const secondsAgo = (s: number) => new Date(Date.now() - s * 1000).toISOString();
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

describe('BoardLiveness (gascity-dashboard-5t0m / fchh)', () => {
  it('reads "all live" in greyscale when every read is fresh, recent, and the stream is up', () => {
    renderLiveness([freshContributor('runs', 'fresh', now())]);
    const line = screen.getByRole('status');
    expect(line.textContent).toContain('all live');
    expect(line.querySelector('.text-accent')).toBeNull(); // One Mark at rest: no mark
  });

  it('flips to maroon on an AGED-stale read — not just on a hard error (blocker 1)', () => {
    // 'fresh' provenance, but the read is 2 minutes old → past the 90s stale
    // floor (ATTENTION_READ_STALE_AFTER_MS).
    renderLiveness([freshContributor('agents', 'fresh', minutesAgo(2))]);
    const line = screen.getByRole('status');
    expect(line.textContent).toContain('agents stale');
    expect(line.querySelector('.text-accent')).not.toBeNull();
  });

  it('flips to maroon on an SSE drop even when every read is fresh (blocker 2)', () => {
    mockSseState = 'closed';
    renderLiveness([freshContributor('runs', 'fresh', now())]);
    const line = screen.getByRole('status');
    expect(line.textContent).toContain('live updates paused');
    expect(line.querySelector('.text-accent')).not.toBeNull();
  });

  it('also degrades on a degraded (not yet closed) stream', () => {
    mockSseState = 'degraded';
    renderLiveness([freshContributor('runs', 'fresh', now())]);
    expect(screen.getByRole('status').querySelector('.text-accent')).not.toBeNull();
  });

  it('renders the degraded state on a cold all-error outage with no landed read (major 3)', () => {
    renderLiveness([freshContributor('agents', 'error', undefined)]);
    const line = screen.getByRole('status');
    expect(line.textContent).not.toContain('as of'); // no age to show
    expect(line.textContent).toContain('agents unreachable');
    expect(line.querySelector('.text-accent')).not.toBeNull();
  });

  it('labels several degraded domains "N degraded" (mixed stale/error), not "N stale" (minor)', () => {
    renderLiveness([
      freshContributor('agents', 'error', now()),
      freshContributor('beads', 'fresh', minutesAgo(2)), // polled read aged → stale
    ]);
    const t = screen.getByRole('status').textContent ?? '';
    expect(t).toContain('2 degraded');
    expect(t).not.toContain('2 stale');
  });

  it('phrases a sub-5s read as "just now", never "now ago" (nit)', () => {
    renderLiveness([freshContributor('runs', 'fresh', secondsAgo(1))]);
    const t = screen.getByRole('status').textContent ?? '';
    expect(t).toContain('as of just now');
    expect(t).not.toContain('now ago');
  });

  it('stays silent until a read has landed and nothing is wrong', () => {
    const { container } = renderLiveness([freshContributor('runs', undefined, undefined)]);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
