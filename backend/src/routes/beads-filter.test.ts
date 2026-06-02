import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { GcBead } from 'gas-city-dashboard-shared';
import { defaultBeadFilter } from './beads.js';

// #33: defaultBeadFilter is the dashboard's "real work"
// predicate. The Beads board reads the filtered feed so its ready count/list
// mirrors the supervisor's `gc bd stats → "Ready to Work"` (~78) instead of
// counting bookkeeping beads (~979). These tests pin the exclusion contract
// against the bead shapes the supervisor actually emits for each synthetic
// namespace, so a regression that re-admits them fails here.

function bead(overrides: Partial<GcBead>): GcBead {
  return {
    id: 'gascity-0001',
    title: 'sample',
    status: 'open',
    priority: 0,
    issue_type: 'task',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('defaultBeadFilter', () => {
  test('keeps engineering work beads', () => {
    for (const issue_type of ['feature', 'bug', 'task', 'docs']) {
      assert.equal(
        defaultBeadFilter(bead({ issue_type })),
        true,
        `expected ${issue_type} to be kept`,
      );
    }
  });

  test('keeps a real task bead with no gc: label (e.g. a workflow root)', () => {
    // mol-focus-review / "Author fix ..." beads: issue_type 'task', no labels.
    assert.equal(defaultBeadFilter(bead({ title: 'mol-focus-review', labels: undefined })), true);
    assert.equal(defaultBeadFilter(bead({ labels: [] })), true);
    assert.equal(defaultBeadFilter(bead({ labels: ['kind/bug'] })), true);
  });

  test('excludes mail-as-beads (issue_type message)', () => {
    assert.equal(defaultBeadFilter(bead({ issue_type: 'message', title: 'polecat closed: gc-x' })), false);
  });

  test('excludes session / identity beads (issue_type session)', () => {
    assert.equal(defaultBeadFilter(bead({ issue_type: 'session', title: 'gascity/oversight-rig.project-lead' })), false);
  });

  test('excludes convoy trackers (issue_type convoy)', () => {
    assert.equal(defaultBeadFilter(bead({ issue_type: 'convoy' })), false);
  });

  test('excludes nudge state beads (issue_type chore, gc:nudge label)', () => {
    assert.equal(
      defaultBeadFilter(bead({ issue_type: 'chore', title: 'nudge:nudge-abc', labels: ['gc:nudge', 'nudge:nudge-abc'] })),
      false,
    );
  });

  test('excludes slack/extmsg beads (task type, gc:extmsg-* label)', () => {
    // Transcript/binding/delivery beads are issue_type 'task' but carry a
    // gc:extmsg-* label — the gc: rule, not the type rule, drops them.
    for (const label of ['gc:extmsg-transcript', 'gc:extmsg-binding', 'gc:extmsg-delivery']) {
      assert.equal(
        defaultBeadFilter(bead({ title: 'slack/T123/C456#7', labels: [label] })),
        false,
        `expected ${label} to be excluded`,
      );
    }
  });

  test('excludes any bead with a gc:-prefixed label regardless of type', () => {
    assert.equal(defaultBeadFilter(bead({ issue_type: 'task', labels: ['gc:anything'] })), false);
  });
});
