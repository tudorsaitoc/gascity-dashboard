import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { GcBead } from 'gas-city-dashboard-shared';

import {
  buildWorkflowSummary,
  createWorkflowsSourceCache,
  fromGcBead,
  MAX_VISIBLE_WORKFLOW_LANES,
  workflowBeadFilter,
} from '../src/snapshot/collectors/workflows.js';
import type { WorkflowIssue } from '../src/snapshot/collectors/phaseMapping.js';

// Lane builder + filter + cache tests for the workflows collector
// (gascity-dashboard-0t6). Ported from demo-dash's workflows.test.ts
// where applicable; gascity-specific additions cover the filter rules
// (C1 in plan review) and the error pass-through contract (H5).

const baseGcBead = {
  description: '',
  status: 'open',
  issue_type: 'task',
  priority: 2,
  created_at: '2026-05-10T19:00:00Z',
  updated_at: '2026-05-10T20:00:00Z',
  metadata: {},
} satisfies Partial<GcBead>;

function gcBead(
  overrides: Partial<GcBead> & Pick<GcBead, 'id' | 'title'>,
): GcBead {
  return {
    ...baseGcBead,
    ...overrides,
    metadata: overrides.metadata ?? {},
  };
}

const baseIssue = {
  description: '',
  status: 'open',
  issue_type: 'task',
  updated_at: '2026-05-10T20:00:00Z',
  metadata: {},
} satisfies Partial<WorkflowIssue>;

function issue(
  overrides: Partial<WorkflowIssue> & Pick<WorkflowIssue, 'id' | 'title'>,
): WorkflowIssue {
  return {
    ...baseIssue,
    ...overrides,
    metadata: overrides.metadata ?? {},
    status: overrides.status ?? 'open',
    issue_type: overrides.issue_type ?? 'task',
    updated_at: overrides.updated_at ?? '2026-05-10T20:00:00Z',
  };
}

// ── workflowBeadFilter ────────────────────────────────────────────────────

describe('workflowBeadFilter', () => {
  test('admits engineering issue types (feature, bug, task, docs)', () => {
    for (const t of ['feature', 'bug', 'task', 'docs']) {
      assert.equal(
        workflowBeadFilter(gcBead({ id: 'a', title: 't', issue_type: t })),
        true,
        `expected ${t} admitted`,
      );
    }
  });

  test('admits molecule beads (the lane roots — C1 fix)', () => {
    assert.equal(
      workflowBeadFilter(
        gcBead({ id: 'a', title: 'mol-adopt-pr-v2', issue_type: 'molecule' }),
      ),
      true,
    );
  });

  test('admits beads with metadata.gc.kind === "workflow" regardless of issue_type', () => {
    assert.equal(
      workflowBeadFilter(
        gcBead({
          id: 'a',
          title: 'workflow root',
          issue_type: 'convoy',
          metadata: { 'gc.kind': 'workflow' },
        }),
      ),
      true,
    );
  });

  test('excludes beads with labels starting "gc:" (session / message noise)', () => {
    assert.equal(
      workflowBeadFilter(
        gcBead({
          id: 'a',
          title: 'session',
          issue_type: 'task',
          labels: ['gc:session'],
        }),
      ),
      false,
    );
  });

  test('excludes convoy-only beads with no workflow metadata', () => {
    assert.equal(
      workflowBeadFilter(
        gcBead({ id: 'a', title: 'convoy', issue_type: 'convoy' }),
      ),
      false,
    );
  });
});

// ── fromGcBead adapter ────────────────────────────────────────────────────

describe('fromGcBead', () => {
  test('maps standard fields verbatim, falls back to empty updated_at', () => {
    const adapted = fromGcBead(
      gcBead({
        id: 'a',
        title: 'Implement',
        assignee: 'alice',
        updated_at: undefined,
        metadata: { foo: 'bar' },
      }),
    );
    assert.equal(adapted.id, 'a');
    assert.equal(adapted.title, 'Implement');
    assert.equal(adapted.assignee, 'alice');
    assert.equal(adapted.updated_at, '');
    assert.deepEqual(adapted.metadata, { foo: 'bar' });
  });

  test('populates parent from metadata["gc.parent_bead_id"] when present', () => {
    const adapted = fromGcBead(
      gcBead({
        id: 'a',
        title: 'step',
        metadata: { 'gc.parent_bead_id': 'parent-id' },
      }),
    );
    assert.equal(adapted.parent, 'parent-id');
  });

  test('leaves parent undefined when metadata key is absent', () => {
    const adapted = fromGcBead(gcBead({ id: 'a', title: 'step' }));
    assert.equal(adapted.parent, undefined);
  });
});

// ── buildWorkflowSummary ──────────────────────────────────────────────────

describe('buildWorkflowSummary', () => {
  test('groups by metadata root and surfaces review round labels', () => {
    const summary = buildWorkflowSummary([
      issue({
        id: 'ga-root',
        title: 'Adopt PR workflow',
        issue_type: 'molecule',
        status: 'open',
        updated_at: '2026-05-10T20:00:00Z',
      }),
      issue({
        id: 'ga-review',
        title: 'Run review loop',
        status: 'in_progress',
        assignee: 'workflows.codex-max',
        updated_at: '2026-05-10T21:00:00Z',
        metadata: {
          'gc.root_bead_id': 'ga-root',
          'review-loop.iteration.3': 'active',
        },
      }),
    ]);

    assert.equal(summary.totalActive, 1);
    assert.equal(summary.lanes.length, 1);
    const lane = summary.lanes[0]!;
    assert.equal(lane.id, 'ga-root');
    assert.equal(lane.title, 'Adopt PR workflow');
    assert.equal(lane.phase, 'review');
    assert.deepEqual(lane.activeAssignees, ['workflows.codex-max']);
    assert.deepEqual(lane.statusCounts, { open: 1, in_progress: 1 });
    assert.equal(lane.updatedAt, '2026-05-10T21:00:00Z');
  });

  test('groups workflow roots and molecule children (M4-c)', () => {
    // Multi-step bead group keyed on molecule id → exactly one lane.
    const summary = buildWorkflowSummary([
      issue({
        id: 'ga-explicit-root',
        title: 'Explicit root',
        status: 'open',
        metadata: { 'gc.kind': 'workflow' },
      }),
      issue({
        id: 'ga-child-a',
        title: 'Implementation child A',
        status: 'in_progress',
        metadata: { molecule_id: 'ga-explicit-root' },
      }),
      issue({
        id: 'ga-child-b',
        title: 'Implementation child B',
        status: 'in_progress',
        metadata: { 'gc.root_bead_id': 'ga-explicit-root' },
      }),
    ]);

    assert.equal(summary.lanes.length, 1);
    const lane = summary.lanes[0]!;
    assert.equal(lane.id, 'ga-explicit-root');
    assert.equal(lane.title, 'Explicit root');
    assert.equal(lane.phase, 'implementation');
    assert.deepEqual(lane.statusCounts, { open: 1, in_progress: 2 });
  });

  test('runCounts.total equals the number of groups, not the visible slice (H1)', () => {
    const lanes = Array.from({ length: 5 }, (_, idx) =>
      issue({
        id: `lane-${idx}`,
        title: `mol-${idx}`,
        issue_type: 'molecule',
        updated_at: `2026-05-10T${String(idx + 10).padStart(2, '0')}:00:00Z`,
      }),
    );
    const summary = buildWorkflowSummary(lanes);
    assert.equal(summary.runCounts.total, summary.lanes.length);
    assert.equal(summary.runCounts.visible, summary.lanes.length);
    assert.equal(summary.totalActive, 5);
  });

  test('caps visible lanes at MAX_VISIBLE_WORKFLOW_LANES while preserving totalActive', () => {
    const summary = buildWorkflowSummary(
      Array.from({ length: MAX_VISIBLE_WORKFLOW_LANES + 3 }, (_, idx) =>
        issue({
          id: `ga-workflow-${idx}`,
          title: `Workflow ${idx}`,
          issue_type: 'molecule',
          updated_at: `2026-05-10T${String(idx + 10).padStart(2, '0')}:00:00Z`,
        }),
      ),
    );

    assert.equal(summary.totalActive, MAX_VISIBLE_WORKFLOW_LANES + 3);
    assert.equal(summary.runCounts.total, MAX_VISIBLE_WORKFLOW_LANES + 3);
    assert.equal(summary.runCounts.visible, MAX_VISIBLE_WORKFLOW_LANES);
    assert.equal(summary.lanes.length, MAX_VISIBLE_WORKFLOW_LANES);
    // Most recently updated lane sorts to position 0.
    assert.equal(
      summary.lanes[0]!.id,
      `ga-workflow-${MAX_VISIBLE_WORKFLOW_LANES + 2}`,
    );
  });

  test('recentChanges sorted by updatedAt desc, capped at 12', () => {
    const issues = Array.from({ length: 20 }, (_, idx) =>
      issue({
        id: `change-${idx}`,
        title: `change ${idx}`,
        updated_at: `2026-05-10T${String(idx).padStart(2, '0')}:00:00Z`,
      }),
    );
    const summary = buildWorkflowSummary(issues);
    assert.equal(summary.recentChanges.length, 12);
    // Most recent change is at index 0.
    assert.equal(summary.recentChanges[0]!.id, 'change-19');
    // Descending order across the entire slice.
    for (let i = 1; i < summary.recentChanges.length; i += 1) {
      const prev = Date.parse(summary.recentChanges[i - 1]!.updatedAt);
      const curr = Date.parse(summary.recentChanges[i]!.updatedAt);
      assert.ok(prev >= curr, `not descending at index ${i}`);
    }
  });

  test('runCounts.prReview counts mol-adopt-pr-v2 lanes', () => {
    const summary = buildWorkflowSummary([
      issue({
        id: 'pr-root',
        title: 'mol-adopt-pr-v2',
        issue_type: 'molecule',
        metadata: { 'gc.formula': 'mol-adopt-pr-v2' },
      }),
    ]);
    assert.equal(summary.runCounts.prReview, 1);
    assert.equal(summary.runCounts.designReview, 0);
    assert.equal(summary.runCounts.bugfix, 0);
  });

  test('runCounts.blocked counts lanes whose phase is blocked', () => {
    const summary = buildWorkflowSummary([
      issue({
        id: 'a',
        title: 'workflow root',
        status: 'blocked',
        issue_type: 'molecule',
      }),
    ]);
    assert.equal(summary.runCounts.blocked, 1);
  });

  // gascity-dashboard-4x3 — defense-in-depth: only http(s) URLs reach the
  // frontend as clickable hrefs. Supervisor bead metadata is the trust
  // boundary; a stored `javascript:` URI would otherwise render as a live
  // link in LaneCard.
  test('externalUrl rejects non-http(s) protocols (javascript:, data:)', () => {
    for (const malicious of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      '/relative/path',
      'example.com/no-protocol',
    ]) {
      const summary = buildWorkflowSummary([
        issue({
          id: 'evil-root',
          title: 'malicious url',
          issue_type: 'molecule',
          metadata: { 'pr_review.pr_url': malicious },
        }),
      ]);
      assert.equal(
        summary.lanes[0]!.externalUrl,
        null,
        `expected ${malicious} rejected`,
      );
    }
  });

  test('externalUrl preserves http(s) URLs from pr_review.pr_url', () => {
    const summary = buildWorkflowSummary([
      issue({
        id: 'pr-root',
        title: 'safe pr url',
        issue_type: 'molecule',
        metadata: { 'pr_review.pr_url': 'https://github.com/o/r/pull/1' },
      }),
    ]);
    assert.equal(
      summary.lanes[0]!.externalUrl,
      'https://github.com/o/r/pull/1',
    );
  });

  test('externalUrl preserves http(s) URLs from bugflow.github_issue_url', () => {
    const summary = buildWorkflowSummary([
      issue({
        id: 'bug-root',
        title: 'safe issue url',
        issue_type: 'molecule',
        metadata: {
          'bugflow.github_issue_url': 'http://github.com/o/r/issues/2',
        },
      }),
    ]);
    assert.equal(
      summary.lanes[0]!.externalUrl,
      'http://github.com/o/r/issues/2',
    );
  });
});

// ── createWorkflowsSourceCache (cache integration) ────────────────────────

describe('createWorkflowsSourceCache', () => {
  test('passes injected load() result through unchanged on success', async () => {
    const summary = buildWorkflowSummary([
      issue({ id: 'a', title: 'Implement the fix' }),
    ]);
    const cache = createWorkflowsSourceCache({
      load: () => summary,
    });
    const result = await cache.get();
    assert.equal(result.status, 'fresh');
    assert.deepEqual(result.data, summary);
  });

  test('error messages pass through verbatim (H5 — sanitizeErrorMessage: null)', async () => {
    const cache = createWorkflowsSourceCache({
      load: () => {
        throw new Error('gc supervisor returned 502');
      },
    });
    const result = await cache.get();
    assert.equal(result.status, 'error');
    assert.equal(result.error, 'gc supervisor returned 502');
  });

  test('falls back to fixture when load() throws and useFixture=true', async () => {
    const fixtureSummary = buildWorkflowSummary([]);
    const cache = createWorkflowsSourceCache({
      useFixture: true,
      loadFixture: () => fixtureSummary,
      load: () => {
        throw new Error('upstream fail');
      },
    });
    const result = await cache.get();
    assert.equal(result.status, 'fixture');
    assert.deepEqual(result.data, fixtureSummary);
  });
});
