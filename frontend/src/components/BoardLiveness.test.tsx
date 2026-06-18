import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SourceStatus } from 'gas-city-dashboard-shared';
import { BoardLiveness } from './BoardLiveness';
import { AttentionProvider } from '../attention/context';
import type { AttentionContributor, AttentionDomain } from '../attention/compose';
import { NowProvider } from '../contexts/NowContext';

afterEach(() => cleanup());

function freshContributor(
  domain: AttentionDomain,
  provenance: SourceStatus | undefined,
  fetchedAt: string | undefined,
): AttentionContributor {
  return {
    id: `${domain}:test`,
    domain,
    getItems: () => [],
    ...(provenance !== undefined && { provenance }),
    ...(fetchedAt !== undefined && { fetchedAt }),
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
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

describe('BoardLiveness (gascity-dashboard-5t0m)', () => {
  it('reads "all live" in greyscale when every domain read is fresh', () => {
    renderLiveness([freshContributor('runs', 'fresh', now())]);

    const line = screen.getByRole('status');
    expect(line.textContent).toMatch(/as of .* ago/);
    expect(line.textContent).toContain('all live');
    // One Mark at rest: no maroon mark in the calm state.
    expect(line.querySelector('.text-accent')).toBeNull();
  });

  it('turns a single maroon glyph + word naming the stale domain', () => {
    renderLiveness([
      freshContributor('runs', 'stale', minutesAgo(5)),
      freshContributor('mail', 'fresh', now()),
    ]);

    const line = screen.getByRole('status');
    expect(line.textContent).toContain('runs stale');
    const mark = line.querySelector('.text-accent');
    expect(mark).not.toBeNull();
    // The word — not just the color — carries the state (Greyscale Test).
    expect(mark?.textContent).toContain('runs stale');
  });

  it('phrases an errored read as "unreachable"', () => {
    renderLiveness([freshContributor('agents', 'error', now())]);
    expect(screen.getByRole('status').textContent).toContain('agents unreachable');
  });

  it('counts rather than lists when several domains are stale', () => {
    renderLiveness([
      freshContributor('runs', 'stale', minutesAgo(5)),
      freshContributor('agents', 'error', minutesAgo(3)),
    ]);
    expect(screen.getByRole('status').textContent).toContain('2 stale');
  });

  it('stays silent until a read has landed', () => {
    const { container } = renderLiveness([freshContributor('runs', undefined, undefined)]);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
