import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { GcBead } from 'gas-city-dashboard-shared';

import type { RunIssue } from '../src/snapshot/collectors/phaseMapping.js';
import {
  buildRunSummary,
  createRunsSourceCache,
  fromGcBead,
  MAX_VISIBLE_Run_LANES,
  RECENT_Run_FETCH_LIMIT,
  runBeadFilter,
} from '../src/snapshot/collectors/runs.js';

// Lane builder + filter + cache tests for the runs collector
// (gascity-dashboard-0t6). Ported from demo-dash's runs.test.ts
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
} satisfies Partial<RunIssue>;

function issue(
  overrides: Partial<RunIssue> & Pick<RunIssue, 'id' | 'title'>,
): RunIssue {
  return {
    ...baseIssue,
    ...overrides,
    metadata: overrides.metadata ?? {},
    status: overrides.status ?? 'open',
    issue_type: overrides.issue_type ?? 'task',
    updated_at: overrides.updated_at ?? '2026-05-10T20:00:00Z',
  };
}

function graphRunMetadata(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    'gc.kind': 'run',
    'gc.formula_contract': 'graph.v2',
    ...overrides,
  };
}

// ── runBeadFilter ────────────────────────────────────────────────────

describe('runBeadFilter', () => {
  test('admits engineering issue types (feature, bug, task, docs)', () => {
    for (const t of ['feature', 'bug', 'task', 'docs']) {
      assert.equal(
        runBeadFilter(gcBead({ id: 'a', title: 't', issue_type: t })),
        true,
        `expected ${t} admitted`,
      );
    }
  });

  test('admits molecule beads (the lane roots — C1 fix)', () => {
    assert.equal(
      runBeadFilter(
        gcBead({ id: 'a', title: 'mol-adopt-pr-v2', issue_type: 'molecule' }),
      ),
      true,
    );
  });

  test('admits beads with metadata.gc.kind === "run" regardless of issue_type', () => {
    assert.equal(
      runBeadFilter(
        gcBead({
          id: 'a',
          title: 'run root',
          issue_type: 'convoy',
          metadata: { 'gc.kind': 'run' },
        }),
      ),
      true,
    );
  });

  test('excludes beads with labels starting "gc:" (session / message noise)', () => {
    assert.equal(
      runBeadFilter(
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

  test('excludes convoy-only beads with no run metadata', () => {
    assert.equal(
      runBeadFilter(
        gcBead({ id: 'a', title: 'convoy', issue_type: 'convoy' }),
      ),
      false,
    );
  });
});

// ── fromGcBead adapter ────────────────────────────────────────────────────

describe('fromGcBead', () => {
  test('maps standard fields verbatim, falls back to created_at when updated_at is absent', () => {
    const source = gcBead({
      id: 'a',
      title: 'Implement',
      assignee: 'alice',
      metadata: { foo: 'bar' },
    });
    delete source.updated_at;

    const adapted = fromGcBead(source);
    assert.equal(adapted.id, 'a');
    assert.equal(adapted.title, 'Implement');
    assert.equal(adapted.assignee, 'alice');
    assert.equal(adapted.updated_at, '2026-05-10T19:00:00Z');
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

// ── buildRunSummary ──────────────────────────────────────────────────

describe('buildRunSummary', () => {
  test('groups by metadata root and surfaces review round labels', () => {
    const summary = buildRunSummary([
      issue({
        id: 'ga-root',
        title: 'Adopt PR run',
        issue_type: 'molecule',
        status: 'open',
        updated_at: '2026-05-10T20:00:00Z',
        metadata: graphRunMetadata(),
      }),
      issue({
        id: 'ga-review',
        title: 'Run review loop',
        status: 'in_progress',
        assignee: 'runs.codex-max',
        updated_at: '2026-05-10T21:00:00Z',
        metadata: {
          'gc.root_bead_id': 'ga-root',
          'review-loop.iteration.3': 'active',
        },
      }),
    ]);

    assert.equal(summary.totalActive, 1);
    assert.deepEqual(summary.census, {
      status: 'unavailable',
      error: 'run health has not been derived',
    });
    assert.deepEqual(summary.lanes[0]?.health, {
      status: 'unavailable',
      error: 'run health has not been derived',
    });
    assert.equal(summary.lanes.length, 1);
    const lane = summary.lanes[0]!;
    assert.equal(lane.id, 'ga-root');
    assert.equal(lane.title, 'Adopt PR run');
    assert.deepEqual(lane.formula, {
      status: 'unavailable',
      error: 'run formula unavailable',
    });
    assert.equal(lane.phase, 'review');
    assert.deepEqual(lane.activeAssignees, ['runs.codex-max']);
    assert.deepEqual(lane.statusCounts, { open: 1, in_progress: 1 });
    assert.deepEqual(lane.updatedAt, {
      status: 'available',
      at: '2026-05-10T21:00:00Z',
    });
    assert.deepEqual(lane.progress, {
      status: 'stage_only',
      stage: {
        status: 'available',
        index: 2,
        key: 'review',
        label: 'Review round 3',
      },
      error: 'active run step unavailable',
    });
  });

  test('carries run formula as an explicit known state', () => {
    const summary = buildRunSummary([
      issue({
        id: 'ga-root',
        title: 'Adopt PR run',
        issue_type: 'molecule',
        status: 'open',
        metadata: graphRunMetadata({
          'gc.formula': 'mol-adopt-pr-v2',
        }),
      }),
    ]);

    assert.deepEqual(summary.lanes[0]!.formula, {
      status: 'known',
      name: 'mol-adopt-pr-v2',
    });
    assert.equal(summary.runCounts.prReview, 1);
  });

  test('carries active run progress as an explicit state', () => {
    const summary = buildRunSummary([
      issue({
        id: 'pr-root',
        title: 'Adopt PR run',
        issue_type: 'molecule',
        status: 'open',
        metadata: graphRunMetadata({
          'gc.formula': 'mol-adopt-pr-v2',
        }),
      }),
      issue({
        id: 'pr-review',
        title: 'Review loop',
        status: 'in_progress',
        assignee: 'runs.codex-max',
        updated_at: '2026-05-10T21:00:00Z',
        metadata: {
          'gc.root_bead_id': 'pr-root',
          'gc.step_id': 'review-loop',
          'review-loop.iteration.2': 'active',
        },
      }),
    ]);

    const lane = summary.lanes[0]!;
    assert.deepEqual(lane.progress, {
      status: 'active_step',
      stepId: 'review-loop',
      stage: {
        status: 'available',
        index: 2,
        key: 'review',
        label: 'Review loop',
      },
      attempt: {
        status: 'available',
        value: 2,
      },
    });
    assert.equal(lane.formulaStageResolved, true);
  });

  test('carries run scope metadata onto lanes for supervisor detail links', () => {
    const summary = buildRunSummary([
      issue({
        id: 'ga-root',
        title: 'Scoped graph run',
        issue_type: 'molecule',
        status: 'open',
        metadata: {
          ...graphRunMetadata(),
          'gc.scope_kind': 'rig',
          'gc.scope_ref': 'worktree',
          'gc.root_store_ref': 'rig:worktree',
        },
      }),
      issue({
        id: 'ga-child',
        title: 'Child scoped to body',
        status: 'in_progress',
        metadata: {
          'gc.root_bead_id': 'ga-root',
          'gc.scope_ref': 'body',
        },
      }),
    ]);

    const lane = summary.lanes[0]!;
    assert.deepEqual(lane.scope, {
      status: 'available',
      kind: 'rig',
      ref: 'worktree',
      rootStoreRef: 'rig:worktree',
    });
  });

  test('omits query scope when explicit scope fields are absent, even with a root_store_ref (gascity-dashboard-sd9)', () => {
    // root_store_ref is a STORAGE location, not a query scope. With no explicit
    // gc.scope_kind/gc.scope_ref, the lane must carry NO query scope so the
    // deep-link resolves the run by id under the city. Deriving the scope
    // from root_store_ref produced a deep-link the supervisor 404s for
    // rig-store-backed runs.
    const summary = buildRunSummary([
      issue({
        id: 'ga-root',
        title: 'Rig-store graph run with no explicit scope',
        issue_type: 'molecule',
        status: 'open',
        metadata: {
          ...graphRunMetadata(),
          'gc.root_store_ref': 'rig:codeprobe',
        },
      }),
      issue({
        id: 'ga-child',
        title: 'Body-scoped child',
        status: 'in_progress',
        metadata: {
          'gc.root_bead_id': 'ga-root',
          'gc.scope_ref': 'body',
        },
      }),
    ]);

    const lane = summary.lanes[0]!;
    assert.deepEqual(lane.scope, {
      status: 'unavailable',
      error: 'run scope metadata unavailable',
    });
  });

  test('groups run roots and molecule children (M4-c)', () => {
    // Multi-step bead group keyed on molecule id → exactly one lane.
    const summary = buildRunSummary([
      issue({
        id: 'ga-explicit-root',
        title: 'Explicit root',
        status: 'open',
        metadata: graphRunMetadata(),
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
        issue_type: 'task',
        metadata: graphRunMetadata(),
        updated_at: `2026-05-10T${String(idx + 10).padStart(2, '0')}:00:00Z`,
      }),
    );
    const summary = buildRunSummary(lanes);
    assert.equal(summary.runCounts.total, summary.lanes.length);
    assert.equal(summary.runCounts.visible, summary.lanes.length);
    assert.equal(summary.totalActive, 5);
  });

  test('caps visible lanes at MAX_VISIBLE_Run_LANES while preserving totalActive', () => {
    const summary = buildRunSummary(
      Array.from({ length: MAX_VISIBLE_Run_LANES + 3 }, (_, idx) =>
        issue({
          id: `ga-run-${idx}`,
          title: `Run ${idx}`,
          issue_type: 'task',
          metadata: graphRunMetadata(),
          updated_at: `2026-05-10T${String(idx + 10).padStart(2, '0')}:00:00Z`,
        }),
      ),
    );

    assert.equal(summary.totalActive, MAX_VISIBLE_Run_LANES + 3);
    assert.equal(summary.runCounts.total, MAX_VISIBLE_Run_LANES + 3);
    assert.equal(summary.runCounts.visible, MAX_VISIBLE_Run_LANES);
    assert.equal(summary.lanes.length, MAX_VISIBLE_Run_LANES);
    // Most recently updated lane sorts to position 0.
    assert.equal(
      summary.lanes[0]!.id,
      `ga-run-${MAX_VISIBLE_Run_LANES + 2}`,
    );
  });

  test('recentChanges sorted by updatedAt desc, capped at 12', () => {
    const issues = [
      issue({
        id: 'change-root',
        title: 'Graph run',
        metadata: graphRunMetadata(),
        updated_at: '2026-05-09T00:00:00Z',
      }),
      ...Array.from({ length: 20 }, (_, idx) =>
        issue({
          id: `change-${idx}`,
          title: `change ${idx}`,
          metadata: { 'gc.root_bead_id': 'change-root' },
          updated_at: `2026-05-10T${String(idx).padStart(2, '0')}:00:00Z`,
        }),
      ),
    ];
    const summary = buildRunSummary(issues);
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
    const summary = buildRunSummary([
      issue({
        id: 'pr-root',
        title: 'mol-adopt-pr-v2',
        issue_type: 'molecule',
        metadata: graphRunMetadata({ 'gc.formula': 'mol-adopt-pr-v2' }),
      }),
    ]);
    assert.equal(summary.runCounts.prReview, 1);
    assert.equal(summary.runCounts.designReview, 0);
    assert.equal(summary.runCounts.bugfix, 0);
  });

  test('runCounts.blocked counts lanes whose phase is blocked', () => {
    const summary = buildRunSummary([
      issue({
        id: 'a',
        title: 'run root',
        status: 'blocked',
        issue_type: 'task',
        metadata: graphRunMetadata(),
      }),
    ]);
    assert.equal(summary.runCounts.blocked, 1);
  });

  test('keeps recently completed graph.v2 run runs visible', () => {
    const summary = buildRunSummary([
      issue({
        id: 'done-root',
        title: 'Completed formula run',
        status: 'closed',
        issue_type: 'molecule',
        updated_at: '2026-05-27T22:00:00Z',
        metadata: graphRunMetadata({
          'gc.formula': 'mol-adopt-pr-v2',
        }),
      }),
      issue({
        id: 'done-review',
        title: 'Review completed',
        status: 'closed',
        updated_at: '2026-05-27T22:01:00Z',
        metadata: {
          'gc.root_bead_id': 'done-root',
          'gc.step_id': 'review-pr',
        },
      }),
    ]);

    assert.equal(summary.lanes.length, 1);
    assert.equal(summary.lanes[0]!.id, 'done-root');
    assert.equal(summary.lanes[0]!.phase, 'complete');
    assert.deepEqual(summary.lanes[0]!.statusCounts, { closed: 2 });
  });

  test('excludes non-graph.v2 molecule groups that cannot open in run detail', () => {
    const summary = buildRunSummary([
      issue({
        id: 'legacy-root',
        title: 'mol-dog-stale-db',
        issue_type: 'molecule',
      }),
      issue({
        id: 'graph-root',
        title: 'Plan Todo App demo',
        issue_type: 'task',
        metadata: graphRunMetadata({
          'gc.root_store_ref': 'rig:todo-app',
        }),
      }),
    ]);

    assert.equal(summary.totalActive, 1);
    assert.deepEqual(summary.lanes.map((lane) => lane.id), ['graph-root']);
  });

  // gascity-dashboard-4x3 — defense-in-depth: only http(s) URLs reach the
  // frontend as clickable hrefs. Supervisor bead metadata is the trust
  // boundary; a stored `javascript:` URI would otherwise render as a live
  // link in LaneCard.
  test('external link rejects non-http(s) protocols without hiding the label', () => {
    for (const malicious of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      '/relative/path',
      'example.com/no-protocol',
    ]) {
      const summary = buildRunSummary([
        issue({
          id: 'evil-root',
          title: 'malicious url',
          issue_type: 'molecule',
          metadata: graphRunMetadata({
            'pr_review.pr_number': '1',
            'pr_review.pr_url': malicious,
          }),
        }),
      ]);
      assert.deepEqual(summary.lanes[0]!.external, {
        status: 'label_only',
        label: 'PR #1',
      }, `expected ${malicious} rejected`);
    }
  });

  test('external link preserves http(s) URLs from pr_review.pr_url', () => {
    const summary = buildRunSummary([
      issue({
        id: 'pr-root',
        title: 'safe pr url',
        issue_type: 'molecule',
        metadata: graphRunMetadata({
          'pr_review.pr_number': '1',
          'pr_review.pr_url': 'https://github.com/o/r/pull/1',
        }),
      }),
    ]);
    assert.deepEqual(summary.lanes[0]!.external, {
      status: 'available',
      label: 'PR #1',
      url: 'https://github.com/o/r/pull/1',
    });
  });

  test('external link preserves http(s) URLs from bugflow.github_issue_url', () => {
    const summary = buildRunSummary([
      issue({
        id: 'bug-root',
        title: 'safe issue url',
        issue_type: 'molecule',
        metadata: graphRunMetadata({
          'bugflow.github_issue_number': '2',
          'bugflow.github_issue_url': 'http://github.com/o/r/issues/2',
        }),
      }),
    ]);
    assert.deepEqual(summary.lanes[0]!.external, {
      status: 'available',
      label: 'Issue #2',
      url: 'http://github.com/o/r/issues/2',
    });
  });
});

// ── createRunsSourceCache (cache integration) ────────────────────────

describe('createRunsSourceCache', () => {
  test('default loader uses bounded typed queries so completed runs appear without an unbounded all=true scan', async () => {
    const seenParams: Array<{
      limit?: number;
      type?: string;
      rig?: string;
      all?: boolean;
    }> = [];
    const cache = createRunsSourceCache({
      gc: {
        listBeads: async (_signal: AbortSignal | undefined, rawParams: unknown) => {
          const params = rawParams as {
            limit?: number;
            type?: string;
            rig?: string;
            all?: boolean;
          };
          seenParams.push(params);
          if (params.all !== true) {
            return {
              items: [
                gcBead({
                  id: 'open-spec',
                  title: 'Open child that identifies the rig',
                  issue_type: 'spec',
                  metadata: {
                    'gc.root_bead_id': 'done-root',
                    'gc.root_store_ref': 'rig:todo-app',
                  },
                }),
              ],
              total: 1,
            };
          }
          if (params.type === 'task' && params.rig === 'todo-app') {
            return {
              items: [
                gcBead({
                  id: 'done-root',
                  title: 'Completed formula run',
                  status: 'closed',
                  issue_type: 'task',
                  metadata: graphRunMetadata({
                    'gc.root_store_ref': 'rig:todo-app',
                    'gc.scope_kind': 'rig',
                    'gc.scope_ref': 'todo-app',
                  }),
                }),
              ],
              total: 1,
            };
          }
          if (params.type === 'molecule') {
            return { items: [], total: 0 };
          }
          assert.fail(`unexpected listBeads params: ${JSON.stringify(params)}`);
        },
      } as never,
      limit: 77,
    });

    const result = await cache.get();

    assert.equal(result.status, 'fresh');
    assert.deepEqual(seenParams, [
      { limit: 77 },
      {
        limit: RECENT_Run_FETCH_LIMIT,
        type: 'task',
        rig: 'todo-app',
        all: true,
      },
      {
        limit: RECENT_Run_FETCH_LIMIT,
        type: 'molecule',
        all: true,
      },
    ]);
    assert.equal(
      seenParams.some((params) => params.all === true && params.type === undefined),
      false,
    );
    if (result.status === 'fresh') {
      assert.equal(result.data.lanes[0]?.id, 'done-root');
    }
  });

  test('default loader includes recent city-scoped molecule runs without requiring a rig', async () => {
    const seenParams: unknown[] = [];
    const cache = createRunsSourceCache({
      gc: {
        listBeads: async (_signal: AbortSignal | undefined, params: unknown) => {
          seenParams.push(params);
          const typed = params as { all?: boolean; type?: string };
          if (typed.all === true && typed.type === 'molecule') {
            return {
              items: [
                gcBead({
                  id: 'done-root',
                  title: 'Completed formula run',
                  status: 'closed',
                  issue_type: 'molecule',
                  metadata: graphRunMetadata(),
                }),
              ],
              total: 1,
            };
          }
          return { items: [], total: 0 };
        },
      } as never,
      limit: 77,
    });

    const result = await cache.get();

    assert.equal(result.status, 'fresh');
    assert.deepEqual(seenParams, [
      { limit: 77 },
      {
        limit: RECENT_Run_FETCH_LIMIT,
        type: 'molecule',
        all: true,
      },
    ]);
    if (result.status === 'fresh') {
      assert.equal(result.data.lanes[0]?.id, 'done-root');
    }
  });

  test('passes injected load() result through unchanged on success', async () => {
    const summary = buildRunSummary([
      issue({ id: 'a', title: 'Implement the fix' }),
    ]);
    const cache = createRunsSourceCache({
      load: () => summary,
    });
    const result = await cache.get();
    assert.equal(result.status, 'fresh');
    assert.deepEqual(result.data, summary);
  });

  test('error messages pass through verbatim (H5 — sanitizeErrorMessage: null)', async () => {
    const cache = createRunsSourceCache({
      load: () => {
        throw new Error('gc supervisor returned 502');
      },
    });
    const result = await cache.get();
    assert.equal(result.status, 'error');
    assert.equal(result.error, 'gc supervisor returned 502');
  });

  test('falls back to fixture when load() throws and useFixture=true', async () => {
    const fixtureSummary = buildRunSummary([]);
    const cache = createRunsSourceCache({
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
