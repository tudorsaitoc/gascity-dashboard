import type { DashboardSnapshot, GcSessionList } from 'gas-city-dashboard-shared';

// Committed sample sessions for SNAPSHOT_USE_FIXTURES=1 mode
// (gascity-dashboard-3ax). The shared sessions cache falls back to these
// when the supervisor is unreachable, so the workflow-health engine can
// resolve the fixture lane's assignees (agent-1 / agent-2) and populate the
// session-fact half of the health derivation instead of degrading every
// fixture lane to unresolved. NOT placed on the /api/snapshot wire.
export const fixtureSessions: GcSessionList = {
  items: [
    {
      id: 'agent-1',
      template: 'codex',
      alias: 'agent-1',
      state: 'active',
      created_at: '2026-05-22T20:00:00.000Z',
      last_active: '2026-05-22T21:59:30.000Z',
      attached: false,
      running: true,
      activity: 'tool_use',
      provider: 'codex',
    },
    {
      id: 'agent-2',
      template: 'claude',
      alias: 'agent-2',
      state: 'active',
      created_at: '2026-05-22T20:05:00.000Z',
      last_active: '2026-05-22T21:58:10.000Z',
      attached: false,
      running: true,
      activity: 'thinking',
      provider: 'claude',
    },
  ],
};

// Committed sample data for SNAPSHOT_USE_FIXTURES=1 runtime mode. This is
// what the dashboard serves when the supervisor / upstream sources are
// unreachable. NOT test fixtures — tests use injected mocks. Adapted from
// demo-dash src/fixtures/snapshot.json with operator-specific names and
// paths replaced by generic placeholders.
//
// Only city / workflows / resources carry realistic data; aimux / github /
// tokens are intentionally null until their collectors are wired (deferred
// pending bead dkb's architecture decisions). The placeholder envelopes
// keep DashboardSources fully populated so callers can index every source
// without optional-chaining churn.

export const fixtureSnapshot = {
  generatedAt: '2026-05-22T22:00:00.000Z',
  config: {
    cityName: 'example-city',
    cityRoot: '/tmp/example-city',
    githubRepo: 'example-org/example-repo',
    useFixtures: true,
  },
  headline: {
    activeAgents: 12,
    maxAgents: 100,
    activeSessions: 28,
    activeWorkflows: 6,
    githubOpenReviews: 14,
  },
  sources: {
    aimux: {
      source: 'aimux',
      status: 'fixture',
      fetchedAt: null,
      staleAt: null,
      error: null,
      data: null,
    },
    city: {
      source: 'city',
      status: 'fixture',
      fetchedAt: '2026-05-22T22:00:00.000Z',
      staleAt: '2026-05-22T22:00:45.000Z',
      error: null,
      data: {
        activeAgents: 12,
        totalAgents: 17,
        activeSessions: 28,
        suspendedSessions: 0,
        maxSessions: 100,
        sessionsByProvider: [
          { provider: 'codex', active: 18, total: 22 },
          { provider: 'claude', active: 7, total: 8 },
          { provider: 'gemini', active: 3, total: 3 },
        ],
        rigs: [
          {
            name: 'rig-1',
            path: '/tmp/example-rig',
          },
        ],
      },
    },
    resources: {
      source: 'resources',
      status: 'fixture',
      fetchedAt: '2026-05-22T22:00:00.000Z',
      staleAt: '2026-05-22T22:00:30.000Z',
      error: null,
      data: {
        vcpuCount: 32,
        loadAverage: [8.4, 7.9, 7.1],
        loadPerVcpu: 0.26,
        memory: {
          totalBytes: 137438953472,
          usedBytes: 60129542144,
          availableBytes: 77309411328,
          utilization: 0.44,
        },
        uptimeSeconds: 86400,
        samples: [
          {
            sampledAt: '2026-05-22T22:00:00.000Z',
            vcpuCount: 32,
            loadAverage: [8.4, 7.9, 7.1],
            loadPerVcpu: 0.26,
            memoryUsedBytes: 60129542144,
            memoryAvailableBytes: 77309411328,
            memoryUtilization: 0.44,
          },
        ],
      },
    },
    workflows: {
      source: 'workflows',
      status: 'fixture',
      fetchedAt: '2026-05-22T22:00:00.000Z',
      staleAt: '2026-05-22T22:01:00.000Z',
      error: null,
      data: {
        totalActive: 6,
        runCounts: {
          total: 6,
          visible: 1,
          prReview: 4,
          designReview: 1,
          bugfix: 1,
          blocked: 1,
          other: 0,
        },
        lanes: [
          {
            id: 'lane-1',
            title: 'Example workflow',
            formula: 'mol-example-v1',
            externalUrl: 'https://github.com/example-org/example-repo/pull/1',
            externalLabel: 'PR #1',
            phase: 'review',
            phaseLabel: 'review round 2',
            statusCounts: {
              open: 3,
              in_progress: 2,
              closed: 8,
            },
            activeAssignees: ['agent-1', 'agent-2'],
            updatedAt: '2026-05-22T21:58:00.000Z',
            stages: [
              { key: 'intake', label: 'Intake', status: 'complete' },
              { key: 'implementation', label: 'Implementation', status: 'complete' },
              { key: 'review', label: 'Review', status: 'active' },
            ],
            // Engine inputs (gascity-dashboard-3ax). 'mol-example-v1' is not a
            // recognised formula, so formulaStageResolved is false → the engine
            // serves this lane as 'inferred' (honest for a degraded-mode sample).
            activeStepId: null,
            activeStepAttempt: null,
            activeStageIndex: 2,
            formulaStageResolved: false,
          },
        ],
        recentChanges: [
          {
            id: 'lane-1.7',
            title: 'Example review',
            status: 'in_progress',
            updatedAt: '2026-05-22T21:58:00.000Z',
          },
        ],
        // census + per-lane health are engine-derived at serve time
        // (gascity-dashboard-3ax); the stored fixture leaves them null and
        // deriveWorkflowHealth fills them in the snapshot read path.
        census: null,
      },
    },
    github: {
      source: 'github',
      status: 'fixture',
      fetchedAt: null,
      staleAt: null,
      error: null,
      data: null,
    },
    tokens: {
      source: 'tokens',
      status: 'fixture',
      fetchedAt: null,
      staleAt: null,
      error: null,
      data: null,
    },
  },
} satisfies DashboardSnapshot;
