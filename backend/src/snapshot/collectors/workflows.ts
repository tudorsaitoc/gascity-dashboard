import type {
  GcBead,
  GcBeadList,
  WorkflowChange,
  WorkflowLane,
  WorkflowRunCounts,
  WorkflowStage,
  WorkflowSummary,
} from 'gas-city-dashboard-shared';

import type { GcClient } from '../../gc-client.js';
import { SourceCache } from '../cache.js';
import {
  mapWorkflowPhase,
  reviewRoundForIssues,
  stringValue,
  type PhaseMapping,
  type WorkflowIssue,
} from './phaseMapping.js';

// Workflows collector — gascity-dashboard-0t6. Ported from demo-dash
// src/server/collectors/workflows.ts (the lane builder, run-count
// aggregation, formula stage progression, and recent-change ordering).
//
// Transport divergence from demo-dash: gc supervisor's HTTP API
// (GcClient.listBeads) returns the unified bead set for the configured
// city; no rig-vs-city split is exposed through HTTP. demo-dash's two
// subprocess calls (city + rig bd directories) merged by workflow_root_id
// were a CLI-side workaround for the subprocess transport — not load-bearing
// for the gascity dashboard. A single `gc.listBeads({ limit })` is the
// canonical contract here (dkb Q1).
//
// Filter divergence from /api/beads (plan review C1): the workflows
// collector keeps the gc:* label exclusion but ALSO admits issue_type
// 'molecule' and beads with metadata['gc.kind'] === 'workflow' — those
// are the very lane-root beads workflowRootId() / displayTitle() key on.
// Reusing routes/beads.ts::defaultBeadFilter would strip them and
// collapse the view to zero lanes; the filter therefore lives co-located
// with the lane builder rather than being shared.

export const WORKFLOWS_CACHE_TTL_MS = 60 * 1000;
export const WORKFLOWS_FETCH_LIMIT = 1_000;
export const MAX_VISIBLE_WORKFLOW_LANES = 8;
const RECENT_CHANGES_CAP = 12;

const ENGINEERING_TYPES = new Set([
  'feature',
  'bug',
  'task',
  'docs',
  'molecule',
]);

const workflowStages = [
  ['intake', 'Intake'],
  ['implementation', 'Implementation'],
  ['review', 'Review'],
  ['approval', 'Approval'],
  ['finalization', 'Finalization'],
] as const;

// ── Filter + adapter ──────────────────────────────────────────────────────

/**
 * Co-located filter for the workflows view. Differs from
 * routes/beads.ts::defaultBeadFilter by admitting molecule and
 * gc.kind='workflow' beads so the lane builder has its root beads to
 * key on. Still excludes gc:* labels (session/message noise).
 */
export function workflowBeadFilter(bead: GcBead): boolean {
  if (Array.isArray(bead.labels) && bead.labels.some((l) => l.startsWith('gc:'))) {
    return false;
  }
  if (ENGINEERING_TYPES.has(bead.issue_type)) {
    return true;
  }
  if (stringValue(bead.metadata?.['gc.kind']) === 'workflow') {
    return true;
  }
  return false;
}

/**
 * Adapt the supervisor wire shape to the lane builder's input. GcBead has
 * no first-class `parent` field, so it is populated from
 * metadata['gc.parent_bead_id'] when present; falls back to undefined.
 */
export function fromGcBead(bead: GcBead): WorkflowIssue {
  const parent = stringValue(bead.metadata?.['gc.parent_bead_id']) || undefined;
  return {
    id: bead.id,
    title: bead.title,
    description: bead.description,
    status: bead.status,
    issue_type: bead.issue_type,
    assignee: bead.assignee,
    updated_at: bead.updated_at ?? '',
    parent,
    metadata: bead.metadata,
  };
}

// ── Lane builder ──────────────────────────────────────────────────────────

export function buildWorkflowSummary(issues: WorkflowIssue[]): WorkflowSummary {
  const groups = new Map<string, WorkflowIssue[]>();

  for (const i of issues) {
    const rootId = workflowRootId(i);
    const group = groups.get(rootId) ?? [];
    group.push(i);
    groups.set(rootId, group);
  }

  const lanes = Array.from(groups.entries())
    .map(([rootId, groupIssues]) => workflowLane(rootId, groupIssues))
    .sort(compareLanes);
  const visibleLanes = lanes.slice(0, MAX_VISIBLE_WORKFLOW_LANES);

  return {
    totalActive: lanes.length,
    runCounts: runCounts(lanes, visibleLanes.length),
    lanes: visibleLanes,
    recentChanges: recentChanges(issues),
    // census is engine-derived (gascity-dashboard-3ax) — the lane builder
    // has no session data and no phaseConfidence yet. deriveWorkflowHealth
    // fills it in the snapshot read path.
    census: null,
  };
}

function runCounts(lanes: WorkflowLane[], visible: number): WorkflowRunCounts {
  const counts: WorkflowRunCounts = {
    total: lanes.length,
    visible,
    prReview: 0,
    designReview: 0,
    bugfix: 0,
    blocked: 0,
    other: 0,
  };

  for (const lane of lanes) {
    if (lane.phase === 'blocked' || (lane.statusCounts.blocked ?? 0) > 0) {
      counts.blocked += 1;
    }
    switch (runKind(lane.formula)) {
      case 'prReview':
        counts.prReview += 1;
        break;
      case 'designReview':
        counts.designReview += 1;
        break;
      case 'bugfix':
        counts.bugfix += 1;
        break;
      default:
        counts.other += 1;
        break;
    }
  }

  return counts;
}

function runKind(
  formula: string | null,
): 'prReview' | 'designReview' | 'bugfix' | 'other' {
  if (formula === 'mol-adopt-pr-v2') return 'prReview';
  if (formula === 'mol-design-review-v2') return 'designReview';
  if (formula === 'mol-bug-report-flow-v2' || formula === 'mol-bug-report-implementation-v2') {
    return 'bugfix';
  }
  return 'other';
}

function workflowLane(rootId: string, issues: WorkflowIssue[]): WorkflowLane {
  const phase = mapWorkflowPhase(issues);
  const updatedAt = latestUpdatedAt(issues);
  const formula = workflowFormula(issues);
  const stages = stageProgress(phase, formula, issues);
  const foundStageIndex = stages.findIndex((s) => s.status === 'active');
  const activeStage = foundStageIndex >= 0 ? stages[foundStageIndex] : undefined;
  // Null (not -1) when no stage is active, matching the WorkflowLane field
  // contract the engine's "graph position flat" check reads.
  const activeStageIndex = foundStageIndex >= 0 ? foundStageIndex : null;

  // Engine inputs for the workflow-health derivation (gascity-dashboard-3ax).
  // activeStepId is the raw gc.step_id of the in-progress primary step — the
  // semantic node id L2 keys on and the `?node=` deep-link target — NOT the
  // coarse stage key. activeStepAttempt is the attempt count of THAT step
  // (not the lossy lane-wide max), so the engine's monotonicity predicate
  // fires on a wedged retry of one step rather than on a stage transition.
  const primaryInProgress = issues.filter(
    (i) => isPrimaryStepIssue(i) && i.status === 'in_progress',
  );
  const activeStepId = latestStepId(primaryInProgress);
  const activeStepAttempt = activeStepId
    ? reviewRoundForIssues(stepIssues(issues, activeStepId))
    : null;

  // Provenance for phaseConfidence (gascity-dashboard-3ax): stages came from
  // a recognised formula AND the active gc.step_id mapped into one of them.
  // Distinguishes a real formula-driven phase from the generic 5-stage
  // fallback / the includes('blocked') sniff (PRD §6 / R2). The engine ANDs
  // this with session-resolution.
  const formulaStages = stagesForFormula(formula);
  const formulaStageResolved =
    formulaStages.length > 0 &&
    activeStepId !== null &&
    formulaStages.some((s) => s.steps.includes(activeStepId));

  return {
    id: rootId,
    title: displayTitle(rootId, issues),
    formula,
    externalUrl: externalUrl(issues),
    externalLabel: externalLabel(issues),
    phase: phase.phase,
    phaseLabel: formula ? (activeStage?.label ?? phase.label) : phase.label,
    statusCounts: statusCounts(issues),
    activeAssignees: activeAssignees(issues),
    updatedAt,
    stages,
    activeStepId,
    activeStepAttempt,
    activeStageIndex,
    formulaStageResolved,
  };
}

function workflowRootId(issue: WorkflowIssue): string {
  const sourceRoot = sourceWorkflowRootId(issue);
  if (sourceRoot) return sourceRoot;

  const metadata = issue.metadata ?? {};
  const explicitRoot = stringValue(metadata['gc.root_bead_id']);
  if (explicitRoot) return explicitRoot;

  if (
    stringValue(metadata['gc.kind']) === 'workflow' ||
    issue.issue_type === 'molecule'
  ) {
    return issue.id;
  }

  const moleculeId = stringValue(metadata.molecule_id);
  if (moleculeId) return moleculeId;

  return issue.id;
}

function sourceWorkflowRootId(issue: WorkflowIssue): string {
  return (
    stringValue(issue.metadata?.['pr_review.workflow_root_id']) ||
    stringValue(issue.metadata?.['bugflow.active_run_id']) ||
    stringValue(issue.metadata?.['bugflow.implementation_workflow_id']) ||
    stringValue(issue.metadata?.['design_review.workflow_root_id'])
  );
}

function displayTitle(rootId: string, issues: WorkflowIssue[]): string {
  const prTitle = metadataString(issues, 'pr_review.github_title');
  const prNumber = metadataString(issues, 'pr_review.pr_number');
  if (prTitle && prNumber) {
    return `PR #${prNumber}: ${prTitle}`;
  }

  const issueUrl = metadataString(issues, 'bugflow.github_issue_url');
  const issueNumber = metadataString(issues, 'bugflow.github_issue_number');
  if (issueUrl && issueNumber) {
    return `Issue #${issueNumber}: ${issues[0]?.title ?? rootId}`;
  }

  const root = issues.find((i) => i.id === rootId);
  return root?.title ?? issues[0]?.title ?? rootId;
}

function statusCounts(issues: WorkflowIssue[]): Record<string, number> {
  return issues.reduce<Record<string, number>>((counts, i) => {
    counts[i.status] = (counts[i.status] ?? 0) + 1;
    return counts;
  }, {});
}

function activeAssignees(issues: WorkflowIssue[]): string[] {
  return Array.from(
    new Set(
      issues
        .filter((i) => i.status !== 'closed')
        .map((i) => i.assignee?.trim())
        .filter((a): a is string => Boolean(a)),
    ),
  ).sort();
}

function latestUpdatedAt(issues: WorkflowIssue[]): string | null {
  return (
    issues
      .map((i) => i.updated_at)
      .filter(Boolean)
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null
  );
}

function recentChanges(issues: WorkflowIssue[]): WorkflowChange[] {
  return [...issues]
    .filter((i) => i.updated_at)
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
    .slice(0, RECENT_CHANGES_CAP)
    .map((i) => ({
      id: i.id,
      title: i.title,
      status: i.status,
      updatedAt: i.updated_at,
    }));
}

// ── Stage progression ─────────────────────────────────────────────────────

function stageProgress(
  phase: PhaseMapping,
  formula: string | null,
  issues: WorkflowIssue[],
): WorkflowStage[] {
  const formulaStages = stagesForFormula(formula);
  if (formulaStages.length > 0) {
    return formulaStageProgress(formulaStages, issues);
  }

  if (phase.phase === 'blocked') {
    return [{ key: 'blocked', label: 'Blocked', status: 'blocked' }];
  }

  if (phase.phase === 'complete') {
    return workflowStages.map(([key, label]) => ({
      key,
      label,
      status: 'complete' as const,
    }));
  }

  const activeIndex = workflowStages.findIndex(([key]) => key === phase.phase);

  if (activeIndex < 0) {
    return workflowStages.map(([key, label]) => ({
      key,
      label,
      status: (key === 'implementation' ? 'active' : 'pending') as WorkflowStage['status'],
    }));
  }

  return workflowStages.map(([key, label], idx) => ({
    key,
    label:
      key === 'review' && phase.reviewRound !== null
        ? `Review round ${phase.reviewRound}`
        : label,
    status: (idx < activeIndex
      ? 'complete'
      : idx === activeIndex
        ? 'active'
        : 'pending') as WorkflowStage['status'],
  }));
}

function stagesForFormula(
  formula: string | null,
): Array<{ key: string; label: string; steps: string[] }> {
  if (formula === 'mol-adopt-pr-v2') {
    return [
      { key: 'preflight', label: 'Preflight', steps: ['preflight'] },
      { key: 'rebase', label: 'Worktree / rebase', steps: ['rebase-check'] },
      {
        key: 'review',
        label: 'Review loop',
        steps: [
          'review-loop',
          'review-pipeline.review-claude',
          'review-pipeline.review-codex',
          'review-pipeline.review-gemini',
          'review-pipeline.synthesize',
          'review-pipeline.quality-scorecard',
          'apply-fixes',
        ],
      },
      {
        key: 'ci',
        label: 'Pre-approval CI',
        steps: ['pre-approval-ci', 'repair-ci-failures'],
      },
      { key: 'approval', label: 'Human approval', steps: ['human-approval'] },
      { key: 'finalize', label: 'Merge-ready', steps: ['finalize'] },
      { key: 'cleanup', label: 'Cleanup', steps: ['cleanup-worktree'] },
    ];
  }

  if (formula === 'mol-design-review-v2') {
    return [
      { key: 'setup', label: 'Setup', steps: ['design-review.setup'] },
      {
        key: 'personas',
        label: 'Personas',
        steps: [
          'design-review.persona-gen-claude',
          'design-review.persona-gen-codex',
          'design-review.persona-gen-gemini',
          'design-review.persona-synthesis',
        ],
      },
      {
        key: 'fanout',
        label: 'Persona fanout',
        steps: [
          'design-review.prepare-review-items',
          'design-review.persona-review-fanout',
        ],
      },
      {
        key: 'synthesis',
        label: 'Synthesis',
        steps: ['design-review.global-synthesis'],
      },
      {
        key: 'apply',
        label: 'Apply findings',
        steps: ['design-review.apply-design-changes'],
      },
      { key: 'finalize', label: 'Finalize', steps: ['finalize'] },
    ];
  }

  if (formula === 'mol-bug-report-flow-v2') {
    return [
      {
        key: 'intake',
        label: 'Intake',
        steps: ['bootstrap-run', 'refresh-intake'],
      },
      {
        key: 'repro',
        label: 'Reproduction',
        steps: ['historical-baseline', 'reported-build-repro', 'main-repro'],
      },
      {
        key: 'audit',
        label: 'Audit',
        steps: ['code-path-audit', 'coverage-audit', 'related-refs-audit'],
      },
      {
        key: 'classify',
        label: 'Classify',
        steps: [
          'investigation-synthesis',
          'followup-evidence',
          'normalize-outcome',
        ],
      },
      {
        key: 'approval',
        label: 'Human approval',
        steps: [
          'approve-classification',
          'verify-classification-approval',
        ],
      },
      { key: 'publish', label: 'Publish', steps: ['publish-classification'] },
      {
        key: 'dispatch',
        label: 'Dispatch fix',
        steps: ['dispatch-implementation'],
      },
    ];
  }

  if (formula === 'mol-bug-report-implementation-v2') {
    return [
      {
        key: 'plan',
        label: 'Plan approval',
        steps: [
          'approve-fix-plan',
          'approve-test-hardening-plan',
          'verify-selected-plan-approval',
        ],
      },
      {
        key: 'design',
        label: 'Design review',
        steps: ['prepare-design-review-doc', 'design-review'],
      },
      {
        key: 'implement',
        label: 'Implement',
        steps: ['implement-change', 'prepare-review-context'],
      },
      {
        key: 'review',
        label: 'Code review',
        steps: ['code-review-loop', 'apply-code-fixes'],
      },
      {
        key: 'pr',
        label: 'Open PR',
        steps: ['approve-pr-open', 'verify-pr-open-approval', 'open-or-update-pr'],
      },
      { key: 'ci', label: 'CI', steps: ['wait-for-ci'] },
      {
        key: 'merge',
        label: 'Merge',
        steps: ['approve-merge', 'verify-merge-approval', 'merge-and-finalize'],
      },
    ];
  }

  return [];
}

function formulaStageProgress(
  stages: Array<{ key: string; label: string; steps: string[] }>,
  issues: WorkflowIssue[],
): WorkflowStage[] {
  const primary = issues.filter(isPrimaryStepIssue);
  const activeStepId = latestStepId(
    primary.filter((i) => i.status === 'in_progress'),
  );
  const activeIndex = activeStepId
    ? stages.findIndex((s) => s.steps.includes(activeStepId))
    : firstOpenStageIndex(stages, primary);
  const furthestClosedIndex = furthestClosedStageIndex(stages, primary);

  const stageHasClosed = (stage: { steps: string[] }): boolean =>
    stage.steps.some((step) =>
      stepIssues(primary, step).some((i) => i.status === 'closed'),
    );

  return stages.map((stage, idx) => {
    let status: WorkflowStage['status'];
    if (activeIndex >= 0) {
      status =
        idx < activeIndex ? 'complete' : idx === activeIndex ? 'active' : 'pending';
    } else if (stageHasClosed(stage) || idx < furthestClosedIndex) {
      status = 'complete';
    } else {
      status = 'pending';
    }
    return { key: stage.key, label: stage.label, status };
  });
}

function firstOpenStageIndex(
  stages: Array<{ steps: string[] }>,
  issues: WorkflowIssue[],
): number {
  return stages.findIndex((s) =>
    s.steps.some((step) =>
      stepIssues(issues, step).some((i) => i.status !== 'closed'),
    ),
  );
}

function furthestClosedStageIndex(
  stages: Array<{ steps: string[] }>,
  issues: WorkflowIssue[],
): number {
  let furthest = -1;
  stages.forEach((s, idx) => {
    if (
      s.steps.some((step) =>
        stepIssues(issues, step).some((i) => i.status === 'closed'),
      )
    ) {
      furthest = idx;
    }
  });
  return furthest;
}

function latestStepId(issues: WorkflowIssue[]): string | null {
  return (
    [...issues]
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
      .map((i) => stringValue(i.metadata?.['gc.step_id']))
      .find(Boolean) ?? null
  );
}

function stepIssues(issues: WorkflowIssue[], step: string): WorkflowIssue[] {
  return issues.filter(
    (i) => stringValue(i.metadata?.['gc.step_id']) === step,
  );
}

function isPrimaryStepIssue(issue: WorkflowIssue): boolean {
  const kind = stringValue(issue.metadata?.['gc.kind']);
  return kind !== 'spec' && kind !== 'scope-check' && kind !== 'workflow-finalize';
}

function compareLanes(a: WorkflowLane, b: WorkflowLane): number {
  const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0;
  const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0;
  return bTime - aTime || a.id.localeCompare(b.id);
}

function workflowFormula(issues: WorkflowIssue[]): string | null {
  return (
    metadataString(issues, 'pr_review.workflow_formula') ||
    metadataString(issues, 'gc.formula') ||
    issues.map((i) => i.title).find((t) => t.startsWith('mol-')) ||
    null
  );
}

function externalUrl(issues: WorkflowIssue[]): string | null {
  // gascity-dashboard-4x3 — defense-in-depth. Supervisor bead metadata is
  // the trust boundary; LaneCard renders this as <a href>. React does not
  // strip `javascript:` from anchor hrefs, so reject anything that is not
  // http(s) before it reaches the frontend.
  const raw =
    metadataString(issues, 'pr_review.pr_url') ||
    metadataString(issues, 'bugflow.github_issue_url');
  return raw && /^https?:\/\//i.test(raw) ? raw : null;
}

function externalLabel(issues: WorkflowIssue[]): string | null {
  const prNumber = metadataString(issues, 'pr_review.pr_number');
  if (prNumber) return `PR #${prNumber}`;
  const issueNumber = metadataString(issues, 'bugflow.github_issue_number');
  if (issueNumber) return `Issue #${issueNumber}`;
  return (
    metadataString(issues, 'pr_review.external_ref') ||
    metadataString(issues, 'bugflow.external_ref') ||
    null
  );
}

function metadataString(issues: WorkflowIssue[], key: string): string {
  return (
    issues.map((i) => stringValue(i.metadata?.[key])).find(Boolean) ?? ''
  );
}

// ── SourceCache wiring ────────────────────────────────────────────────────

export function emptyWorkflowSummary(): WorkflowSummary {
  return {
    totalActive: 0,
    runCounts: {
      total: 0,
      visible: 0,
      prReview: 0,
      designReview: 0,
      bugfix: 0,
      blocked: 0,
      other: 0,
    },
    lanes: [],
    recentChanges: [],
    census: null,
  };
}

export interface CreateWorkflowsSourceCacheOptions {
  /** Live source for beads. Required unless `load` is injected directly. */
  gc?: GcClient;
  /** Per-call fetch cap. Defaults to WORKFLOWS_FETCH_LIMIT. */
  limit?: number;
  now?: () => Date;
  loadFixture?: () => Promise<WorkflowSummary> | WorkflowSummary;
  useFixture?: boolean;
  /** Test seam: override the loader entirely (bypasses gc + filter + adapter). */
  load?: () => Promise<WorkflowSummary> | WorkflowSummary;
}

export function createWorkflowsSourceCache(
  options: CreateWorkflowsSourceCacheOptions = {},
): SourceCache<WorkflowSummary> {
  const load = options.load ?? buildDefaultLoad(options);

  // sanitizeErrorMessage: null — GcClient.listBeads throws messages of
  // the shape `gc supervisor returned ${status}` which are already
  // operator-safe; collapsing them to "workflows collection failed"
  // would discard signal. Internal logic bugs in buildWorkflowSummary
  // are operator-meaningful too. Mirrors the city collector's posture.
  return new SourceCache<WorkflowSummary>({
    source: 'workflows',
    ttlMs: WORKFLOWS_CACHE_TTL_MS,
    now: options.now,
    sanitizeErrorMessage: null,
    load,
    loadFixture: options.loadFixture,
    useFixture: options.useFixture,
  });
}

function buildDefaultLoad(
  options: CreateWorkflowsSourceCacheOptions,
): () => Promise<WorkflowSummary> {
  const { gc } = options;
  if (!gc) {
    throw new Error(
      'createWorkflowsSourceCache requires either { gc } or { load } (test seam).',
    );
  }
  const limit = options.limit ?? WORKFLOWS_FETCH_LIMIT;
  return async () => {
    const list: GcBeadList = await gc.listBeads(undefined, { limit });
    const filtered = list.items.filter(workflowBeadFilter);
    const adapted = filtered.map(fromGcBead);
    return buildWorkflowSummary(adapted);
  };
}
