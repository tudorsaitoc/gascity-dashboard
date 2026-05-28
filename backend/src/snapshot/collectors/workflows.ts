import type {
  GcBead,
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

// Workflows collector — gascity-dashboard-0t6. Owns lane building, run-count
// aggregation, formula stage progression, and recent-change ordering.
//
// The gc supervisor HTTP API (GcClient.listBeads) returns the unified bead set
// for the configured city. A single `gc.listBeads({ limit })` is the canonical
// contract here (dkb Q1).
//
// Filter divergence from /api/beads (plan review C1): the workflows
// collector keeps the gc:* label exclusion but ALSO admits issue_type
// 'molecule' and beads with metadata['gc.kind'] === 'workflow' so graph.v2
// root groups have enough context to build lanes. The final lane list is
// intentionally graph.v2-only; non-graph formula molecules are filtered out
// after grouping because the detail route cannot render them.

export const WORKFLOWS_CACHE_TTL_MS = 60 * 1000;
export const WORKFLOWS_FETCH_LIMIT = 1_000;
export const RECENT_WORKFLOW_FETCH_LIMIT = 80;
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
  const issue: WorkflowIssue = {
    id: bead.id,
    title: bead.title,
    status: bead.status,
    issue_type: bead.issue_type,
    updated_at: bead.updated_at ?? bead.closed_at ?? bead.created_at,
  };
  if (bead.description !== undefined) issue.description = bead.description;
  if (bead.assignee !== undefined) issue.assignee = bead.assignee;
  if (parent !== undefined) issue.parent = parent;
  if (bead.metadata !== undefined) issue.metadata = bead.metadata;
  return issue;
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

  const workflowGroups = Array.from(groups.entries()).filter(([rootId, groupIssues]) =>
    isGraphV2WorkflowGroup(rootId, groupIssues),
  );
  const laneIssues = workflowGroups.flatMap(([, groupIssues]) => groupIssues);
  const lanes = workflowGroups
    .map(([rootId, groupIssues]) => workflowLane(rootId, groupIssues))
    .sort(compareLanes);
  const visibleLanes = lanes.slice(0, MAX_VISIBLE_WORKFLOW_LANES);

  return {
    totalActive: lanes.length,
    runCounts: runCounts(lanes, visibleLanes.length),
    lanes: visibleLanes,
    recentChanges: recentChanges(laneIssues),
    // census is engine-derived (gascity-dashboard-3ax) — the lane builder
    // has no session data and no phaseConfidence yet. deriveWorkflowHealth
    // replaces this state in the snapshot read path.
    census: workflowCensusUnavailable(),
  };
}

function isGraphV2WorkflowGroup(rootId: string, issues: WorkflowIssue[]): boolean {
  const root = issues.find((issue) => issue.id === rootId);
  return stringValue(root?.metadata?.['gc.formula_contract']) === 'graph.v2';
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
      case 'other':
        counts.other += 1;
        break;
    }
  }

  return counts;
}

function runKind(
  formula: WorkflowLane['formula'],
): 'prReview' | 'designReview' | 'bugfix' | 'other' {
  const formulaName = workflowFormulaName(formula);
  if (formulaName === 'mol-adopt-pr-v2') return 'prReview';
  if (formulaName === 'mol-design-review-v2') return 'designReview';
  if (formulaName === 'mol-bug-report-flow-v2' || formulaName === 'mol-bug-report-implementation-v2') {
    return 'bugfix';
  }
  return 'other';
}

function workflowLane(rootId: string, issues: WorkflowIssue[]): WorkflowLane {
  const phase = mapWorkflowPhase(issues);
  const updatedAt = latestUpdatedAt(issues);
  const formula = workflowFormula(issues);
  const formulaName = workflowFormulaName(formula);
  const stages = stageProgress(phase, formulaName, issues);
  const foundStageIndex = stages.findIndex((s) => s.status === 'active');
  const activeStage = foundStageIndex >= 0 ? stages[foundStageIndex] : undefined;

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
  const progress = workflowProgress(stages, foundStageIndex, activeStepId, issues);

  // Provenance for phaseConfidence (gascity-dashboard-3ax): stages came from
  // a recognised formula AND the active gc.step_id mapped into one of them.
  // Distinguishes a real formula-driven phase from the generic 5-stage
  // fallback / the includes('blocked') sniff (PRD §6 / R2). The engine ANDs
  // this with session-resolution.
  const formulaStages = stagesForFormula(formulaName);
  const formulaStageResolved =
    formulaStages.length > 0 &&
    progress.status === 'active_step' &&
    formulaStages.some((s) => s.steps.includes(progress.stepId));
  const scope = workflowScope(rootId, issues);

  const lane: WorkflowLane = {
    id: rootId,
    title: displayTitle(rootId, issues),
    formula,
    scope,
    external: externalReference(issues),
    phase: phase.phase,
    phaseLabel: formula.status === 'known' ? (activeStage?.label ?? phase.label) : phase.label,
    statusCounts: statusCounts(issues),
    activeAssignees: activeAssignees(issues),
    updatedAt,
    stages,
    progress,
    formulaStageResolved,
    health: workflowHealthUnavailable(),
  };
  return lane;
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

function workflowScope(
  rootId: string,
  issues: WorkflowIssue[],
): WorkflowScopeInfo {
  const root = issues.find((i) => i.id === rootId);
  const ordered = root
    ? [root, ...issues.filter((issue) => issue !== root)]
    : issues;
  const rootStoreRef = metadataString(ordered, 'gc.root_store_ref');
  const rootScopeKind = stringValue(root?.metadata?.['gc.scope_kind']);
  const rootScopeRef = stringValue(root?.metadata?.['gc.scope_ref']);
  // The query scope (scopeKind/scopeRef) drives the run-detail deep-link, so it
  // must come ONLY from explicit gc.scope_kind / gc.scope_ref. root_store_ref is
  // a STORAGE location, not a query scope: deriving the scope from it produces a
  // deep-link the supervisor's /workflow/{id} endpoint 404s for rig-store-backed
  // workflows, whose root id actually resolves under the city (gascity-dashboard-sd9).
  // When explicit scope metadata is absent, leave the scope null so the deep-link
  // carries no scope and the workflow resolves by id under the city. rootStoreRef
  // is still surfaced as a display-only field.
  const scopeKind = parseWorkflowScopeKind(rootScopeKind);
  const scopeRef =
    scopeKind !== null
      ? rootScopeRef || metadataString(ordered, 'gc.scope_ref') || null
      : null;

  if (scopeKind !== null && scopeRef !== null) {
    return {
      status: 'available',
      kind: scopeKind,
      ref: scopeRef,
      rootStoreRef: rootStoreRef || `${scopeKind}:${scopeRef}`,
    };
  }

  return {
    status: 'unavailable',
    error: 'workflow scope metadata unavailable',
  };
}

type WorkflowScopeInfo = WorkflowLane['scope'];

function parseWorkflowScopeKind(value: string): 'city' | 'rig' | null {
  return value === 'city' || value === 'rig' ? value : null;
}

function scopeKindFromStoreRef(rootStoreRef: string | null): 'city' | 'rig' | null {
  const [kind] = (rootStoreRef ?? '').split(':', 1);
  return parseWorkflowScopeKind(kind ?? '');
}

function scopeRefFromStoreRef(rootStoreRef: string | null): string | null {
  const ref = rootStoreRef ?? '';
  const colon = ref.indexOf(':');
  return colon >= 0 && colon < ref.length - 1 ? ref.slice(colon + 1) : null;
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

function latestUpdatedAt(issues: WorkflowIssue[]): WorkflowLane['updatedAt'] {
  const at = issues
    .map((i) => i.updated_at)
    .filter(Boolean)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];

  return at === undefined
    ? { status: 'unavailable', error: 'workflow update time unavailable' }
    : { status: 'available', at };
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

function workflowProgress(
  stages: WorkflowStage[],
  activeStageIndex: number,
  activeStepId: string | null,
  issues: WorkflowIssue[],
): WorkflowLane['progress'] {
  const stage = workflowStagePosition(stages, activeStageIndex);
  if (activeStepId !== null) {
    return {
      status: 'active_step',
      stepId: activeStepId,
      stage,
      attempt: workflowStepAttempt(issues, activeStepId),
    };
  }

  if (stage.status === 'available') {
    return {
      status: 'stage_only',
      stage,
      error: 'active workflow step unavailable',
    };
  }

  return { status: 'unavailable', error: 'workflow progress unavailable' };
}

function workflowStagePosition(
  stages: WorkflowStage[],
  activeStageIndex: number,
): Extract<WorkflowLane['progress'], { status: 'active_step' }>['stage'] {
  const stage = stages[activeStageIndex];
  return stage === undefined
    ? { status: 'unavailable', error: 'active workflow stage unavailable' }
    : {
        status: 'available',
        index: activeStageIndex,
        key: stage.key,
        label: stage.label,
      };
}

function workflowStepAttempt(
  issues: WorkflowIssue[],
  stepId: string,
): Extract<WorkflowLane['progress'], { status: 'active_step' }>['attempt'] {
  const value = reviewRoundForIssues(stepIssues(issues, stepId));
  return value === null
    ? { status: 'unavailable', error: 'workflow step attempt unavailable' }
    : { status: 'available', value };
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
  const aTime = a.updatedAt.status === 'available' ? Date.parse(a.updatedAt.at) : 0;
  const bTime = b.updatedAt.status === 'available' ? Date.parse(b.updatedAt.at) : 0;
  return bTime - aTime || a.id.localeCompare(b.id);
}

function workflowFormula(issues: WorkflowIssue[]): WorkflowLane['formula'] {
  const name =
    metadataString(issues, 'pr_review.workflow_formula') ||
    metadataString(issues, 'gc.formula') ||
    issues.map((i) => i.title).find((t) => t.startsWith('mol-')) ||
    null;
  return name === null
    ? { status: 'unavailable', error: 'workflow formula unavailable' }
    : { status: 'known', name };
}

function workflowFormulaName(formula: WorkflowLane['formula']): string | null {
  return formula.status === 'known' ? formula.name : null;
}

function externalReference(issues: WorkflowIssue[]): WorkflowLane['external'] {
  const label = externalLabel(issues);
  const url = externalUrl(issues);
  if (label !== null && url !== null) {
    return { status: 'available', label, url };
  }
  if (label !== null) {
    return { status: 'label_only', label };
  }
  return { status: 'unavailable', error: 'external reference unavailable' };
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
    census: workflowCensusUnavailable(),
  };
}

function workflowCensusUnavailable(): WorkflowSummary['census'] {
  return {
    status: 'unavailable',
    error: 'workflow health has not been derived',
  };
}

function workflowHealthUnavailable(): WorkflowLane['health'] {
  return {
    status: 'unavailable',
    error: 'workflow health has not been derived',
  };
}

export interface CreateWorkflowsSourceCacheOptions {
  /** Live source for beads. Required unless `load` is injected directly. */
  gc?: GcClient | undefined;
  /** Per-call fetch cap. Defaults to WORKFLOWS_FETCH_LIMIT. */
  limit?: number | undefined;
  now?: (() => Date) | undefined;
  loadFixture?: (() => Promise<WorkflowSummary> | WorkflowSummary) | undefined;
  useFixture?: boolean | undefined;
  /** Test seam: override the loader entirely (bypasses gc + filter + adapter). */
  load?: (() => Promise<WorkflowSummary> | WorkflowSummary) | undefined;
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
    const items = await loadWorkflowBeads(gc, limit);
    const filtered = items.filter(workflowBeadFilter);
    const adapted = filtered.map(fromGcBead);
    return buildWorkflowSummary(adapted);
  };
}

async function loadWorkflowBeads(
  gc: GcClient,
  limit: number,
): Promise<GcBead[]> {
  const active = await gc.listBeads(undefined, { limit });
  const rigNames = workflowRigNames(active.items);
  const recentLists = await Promise.all([
    ...rigNames.map((rig) =>
      gc.listBeads(undefined, {
        limit: RECENT_WORKFLOW_FETCH_LIMIT,
        type: 'task',
        rig,
        all: true,
      }),
    ),
    gc.listBeads(undefined, {
      limit: RECENT_WORKFLOW_FETCH_LIMIT,
      type: 'molecule',
      all: true,
    }),
  ]);

  return uniqueBeads([
    ...active.items,
    ...recentLists.flatMap((list) => list.items),
  ]);
}

function workflowRigNames(beads: readonly GcBead[]): string[] {
  const names = new Set<string>();
  for (const bead of beads) {
    const rootStoreRef = stringValue(bead.metadata?.['gc.root_store_ref']);
    const storeKind = scopeKindFromStoreRef(rootStoreRef);
    const storeRef = scopeRefFromStoreRef(rootStoreRef);
    if (storeKind === 'rig' && storeRef !== null) {
      names.add(storeRef);
      continue;
    }

    const scopeKind = parseWorkflowScopeKind(stringValue(bead.metadata?.['gc.scope_kind']));
    const scopeRef = stringValue(bead.metadata?.['gc.scope_ref']);
    if (scopeKind === 'rig' && scopeRef.length > 0) {
      names.add(scopeRef);
    }
  }
  return Array.from(names).sort();
}

function uniqueBeads(beads: readonly GcBead[]): GcBead[] {
  const byId = new Map<string, GcBead>();
  for (const bead of beads) {
    if (!byId.has(bead.id)) byId.set(bead.id, bead);
  }
  return Array.from(byId.values());
}
