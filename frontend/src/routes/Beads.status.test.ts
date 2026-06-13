import { describe, expect, it } from 'vitest';
import type { SupervisorBead } from '../supervisor/beadReads';
import { BEAD_CHIPS, buildSynopsis } from './Beads';

// The city bead list can emit supervisor-wire status spellings (`active`/`running`
// for in-flight, `completed`/`done`/`failed`/`skipped` for terminal) alongside the
// bd-ledger spellings (`in_progress`, `closed`). The board's chips and synopsis
// route through the shared isInFlightStatus/isResolvedStatus predicates so a
// wire-spelled bead is columned, counted, and closeable the same as its bd-ledger
// twin — never silently mis-filtered. failed/skipped are terminal too: no work
// remains, so they belong under the closed filter. These pin that both
// vocabularies classify identically.

function bead(status: string): SupervisorBead {
  return {
    id: `td-${status}`,
    title: `${status} bead`,
    status,
    issue_type: 'task',
    priority: 0,
    labels: [],
    created_at: '2026-06-01T00:00:00Z',
  };
}

function chipMatch(id: string): (bead: SupervisorBead) => boolean {
  const chip = BEAD_CHIPS.find((c) => c.id === id);
  if (chip === undefined) throw new Error(`missing chip ${id}`);
  return chip.match;
}

describe('Beads board — supervisor wire status vocabulary', () => {
  it('the in-progress chip matches bd in_progress and wire active/running, not closed spellings', () => {
    const match = chipMatch('in_progress');
    expect(match(bead('in_progress'))).toBe(true);
    expect(match(bead('active'))).toBe(true);
    expect(match(bead('running'))).toBe(true);
    expect(match(bead('open'))).toBe(false);
    expect(match(bead('completed'))).toBe(false);
    expect(match(bead('done'))).toBe(false);
    // Terminal failed/skipped are resolved, not in-flight.
    expect(match(bead('failed'))).toBe(false);
    expect(match(bead('skipped'))).toBe(false);
  });

  it('the closed chip matches bd closed and all terminal wire spellings (completed/done/failed/skipped), not in-flight', () => {
    const match = chipMatch('closed');
    expect(match(bead('closed'))).toBe(true);
    expect(match(bead('completed'))).toBe(true);
    expect(match(bead('done'))).toBe(true);
    // failed and skipped are terminal/resolved — they belong under the closed
    // filter, not left unmatched by every chip.
    expect(match(bead('failed'))).toBe(true);
    expect(match(bead('skipped'))).toBe(true);
    expect(match(bead('active'))).toBe(false);
    expect(match(bead('running'))).toBe(false);
    expect(match(bead('open'))).toBe(false);
  });

  it('the open chip normalizes cased / padded open spellings and rejects others', () => {
    const match = chipMatch('open');
    expect(match(bead('open'))).toBe(true);
    expect(match(bead('Open'))).toBe(true);
    expect(match(bead(' open '))).toBe(true);
    expect(match(bead('blocked'))).toBe(false);
    expect(match(bead('in_progress'))).toBe(false);
    expect(match(bead('closed'))).toBe(false);
  });

  it('the blocked chip normalizes cased / padded blocked spellings and rejects others', () => {
    const match = chipMatch('blocked');
    expect(match(bead('blocked'))).toBe(true);
    expect(match(bead('Blocked'))).toBe(true);
    expect(match(bead(' blocked '))).toBe(true);
    expect(match(bead('open'))).toBe(false);
    expect(match(bead('active'))).toBe(false);
    expect(match(bead('closed'))).toBe(false);
  });

  it('the synopsis counts wire active/running in the in-progress tally', () => {
    const rows = [
      bead('open'),
      bead('in_progress'),
      bead('active'),
      bead('running'),
      bead('blocked'),
    ];
    const summary = buildSynopsis(rows, rows.length, '');
    // in_progress + active + running all roll into the one "in progress" count.
    expect(summary).toContain('3 in progress');
    expect(summary).toContain('1 open');
    expect(summary).toContain('1 blocked');
  });

  it('the synopsis tallies open / blocked under cased and padded wire spellings', () => {
    const rows = [bead('Open'), bead(' open '), bead('Blocked'), bead(' blocked ')];
    const summary = buildSynopsis(rows, rows.length, '');
    expect(summary).toContain('2 open');
    expect(summary).toContain('2 blocked');
  });
});
