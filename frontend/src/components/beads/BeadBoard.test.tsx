import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GcBead, BeadStatus } from 'gas-city-dashboard-shared';
import { buildBeadGraph } from '../../lib/beadGraph';
import { assertAtMostOneMark } from '../../test/assertions/oneMarkRule';
import { BeadBoard } from './BeadBoard';

afterEach(() => cleanup());

function bead(
  id: string,
  status: BeadStatus,
  extra: Partial<GcBead> = {},
): GcBead {
  return {
    id,
    title: `bead ${id}`,
    status,
    issue_type: 'task',
    priority: null,
    created_at: '2026-05-01T00:00:00Z',
    ...extra,
  };
}

function renderBoard(
  beads: GcBead[],
  selectedId: string | null = null,
  onSelect = vi.fn(),
) {
  const graph = buildBeadGraph(beads);
  const result = render(
    <BeadBoard
      columns={graph.columns}
      selectedId={selectedId}
      onSelect={onSelect}
    />,
  );
  return { ...result, onSelect };
}

describe('BeadBoard', () => {
  it('renders every status column as a labelled section', () => {
    renderBoard([bead('A', 'open')]);
    for (const label of ['ready', 'open', 'in progress', 'blocked', 'done']) {
      expect(screen.getByRole('region', { name: label })).toBeTruthy();
    }
  });

  it('places a bead under the column its status maps to', () => {
    renderBoard([
      bead('A', 'in_progress', { title: 'live one' }),
      bead('Z', 'closed', { title: 'finished one' }),
    ]);
    const inProgress = screen.getByRole('region', { name: 'in progress' });
    expect(within(inProgress).getByText('live one')).toBeTruthy();
    const done = screen.getByRole('region', { name: 'done' });
    expect(within(done).getByText('finished one')).toBeTruthy();
  });

  it('calls onSelect when a bead is clicked', () => {
    const { onSelect } = renderBoard([bead('A', 'open', { title: 'pick me' })]);
    fireEvent.click(screen.getByText('pick me'));
    expect(onSelect).toHaveBeenCalledWith('A');
  });

  it('expands needs/blocks sub-rows for the selected bead and re-centres on click', () => {
    const onSelect = vi.fn();
    // A is closed (done column); B needs A so B is ready (ready column). The
    // selected bead B shows its upstream dependency A as a typeset sub-row
    // inside its own column, distinct from A's own row in the done column.
    renderBoard(
      [bead('A', 'closed'), bead('B', 'open', { needs: ['A'] })],
      'B',
      onSelect,
    );
    const ready = screen.getByRole('region', { name: 'ready' });
    fireEvent.click(within(ready).getByTitle('Select A'));
    expect(onSelect).toHaveBeenCalledWith('A');
  });

  it('renders an unresolved upstream edge without a navigation target', () => {
    renderBoard([bead('B', 'open', { needs: ['GHOST'] })], 'B');
    // Two "unresolved" marks: the row summary + the sub-row label. Neither
    // points anywhere (no Select GHOST button).
    expect(screen.queryByTitle('Select GHOST')).toBeNull();
    expect(screen.getAllByText('unresolved').length).toBeGreaterThan(0);
  });

  it('keeps the board to at most one maroon mark (the blocked count)', () => {
    const { container } = renderBoard([
      bead('A', 'blocked'),
      bead('B', 'in_progress'),
      bead('C', 'open'),
    ]);
    assertAtMostOneMark(container);
  });

  it('does not carry status in colour alone — every column is a named heading', () => {
    // Greyscale Test: the status of a bead is readable from the column
    // heading it sits under, not from a per-row colour.
    renderBoard([bead('A', 'blocked', { title: 'stuck one' })]);
    const blocked = screen.getByRole('region', { name: 'blocked' });
    expect(within(blocked).getByText('stuck one')).toBeTruthy();
  });
});
