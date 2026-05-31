import {
  SCOPE_REF_RE,
  type GcBead,
  type RunChange,
  type RunLane,
  type RunCounts,
  type RunStage,
  type RunSummary,
} from 'gas-city-dashboard-shared';

import type { GcClient } from '../../gc-client.js';
import { LOG_COMPONENT, errorMessage, logWarn } from '../../logging.js';
import { SourceCache } from '../cache.js';
import {
  fromGcBead,
  isPrimaryStepIssue,
  latestStepId,
  mapRunPhase,
  reviewRoundForIssues,
  stageProgress,
  stagesForFormula,
  stepIssues,
  stringValue,
  type RunIssue,
} from './phaseMapping.js';

export { fromGcBead } from './phaseMapping.js';

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
// 'molecule' and beads with metadata['gc.kind'] === 'run' so graph.v2
// root groups have enough context to build lanes. The final lane list is
// intentionally graph.v2-only; non-graph formula molecules are filtered out
// after grouping because the detail route cannot render them.

export const RUNS_CACHE_TTL_MS = 60 * 1000;
export const RUNS_FETCH_LIMIT = 1_000;
export const RECENT_RUN_FETCH_LIMIT = 80;
/**
 * gascity-dashboard-yh5i: the lane set is split into active (default
 * visible) and historical (toggle-visible). Each side has its own cap so
 * complete lanes can never crowd active out of the visible window.
 * Historical cap is intentionally smaller — the toggle is a "skim recent
 * completions" tool, not a full archive.
 */
export const MAX_VISIBLE_ACTIVE_LANES = 8;
export const MAX_VISIBLE_HISTORICAL_LANES = 5;
const RECENT_CHANGES_CAP = 12;

const ENGINEERING_TYPES = new Set([
  'feature',
  'bug',
  'task',
  'docs',
  'molecule',
]);

// ── Filter + adapter ──────────────────────────────────────────────────────

/**
 * Co-located filter for the workflows view. Differs from
 * routes/beads.ts::defaultBeadFilter by admitting molecule and
 * gc.kind='workflow' beads so the lane builder has its root beads to
 * key on. Still excludes gc:* labels (session/message noise).
 */
export function runBeadFilter(bead: GcBead): boolean {
  if (Array.isArray(bead.labels) && bead.labels.some((l) => l.startsWith('gc:'))) {
    return false;
  }
  if (ENGINEERING_TYPES.has(bead.issue_type)) {
    return true;
  }
  if (stringValue(bead.metadata?.['gc.kind']) === 'run') {
    return true;
  }
  return false;
}

// ── Lane builder ──────────────────────────────────────────────────────────

/**
 * Per-root supervisor query scope sourced from /v0/city/<city>/formulas/feed.
 * gascity-dashboard-d3xp: a rig-stored workflow root surfaced by the ej9y
 * feed-discovery path typically does NOT carry gc.scope_kind/gc.scope_ref
 * in its bead metadata, but the feed's own scope_kind/scope_ref IS the
 * supervisor's authoritative query scope for the run. This map carries
 * that authority to the lane builder so the deep-link qs is correct.
 */
export interface RunFeedScope {
  scopeKind: 'city' | 'rig';
  scopeRef: string;
  rootStoreRef: string;
}
export type RunFeedScopeMap = ReadonlyMap<string, RunFeedScope>;

export function buildRunSummary(
  issues: RunIssue[],
  feedScopes: RunFeedScopeMap = new Map(),
  partial = false,
): RunSummary {
  const groups = new Map<string, RunIssue[]>();

  for (const i of issues) {
    const rootId = runRootId(i);
    const group = groups.get(rootId) ?? [];
    group.push(i);
    groups.set(rootId, group);
  }

  const runGroups = Array.from(groups.entries()).filter(([rootId, groupIssues]) =>
    isGraphV2RunGroup(rootId, groupIssues),
  );
  const laneIssues = runGroups.flatMap(([, groupIssues]) => groupIssues);
  const sortedLanes = runGroups
    .map(([rootId, groupIssues]) => runLane(rootId, groupIssues, feedScopes))
    .sort(compareLanes);

  // gascity-dashboard-yh5i: split by phase so the /workflows view can
  // default to active lanes with historical behind a toggle. The split
  // happens AFTER sorting so each side's visible window remains in
  // compareLanes order (most-recent-first within each group). Blocked
  // lanes go into ACTIVE (not historical) — they still need operator
  // attention; the in-flight census disagrees only because totalInFlight
  // is a different concept (currently-progressing work).
  const activeLanes = sortedLanes.filter((lane) => lane.phase !== 'complete');
  const historicalLanes = sortedLanes.filter((lane) => lane.phase === 'complete');
  const visibleActive = activeLanes.slice(0, MAX_VISIBLE_ACTIVE_LANES);
  const visibleHistorical = historicalLanes.slice(0, MAX_VISIBLE_HISTORICAL_LANES);

  const summary: RunSummary = {
    totalActive: activeLanes.length,
    totalHistorical: historicalLanes.length,
    runCounts: runCounts(activeLanes, visibleActive.length),
    lanes: visibleActive,
    historicalLanes: visibleHistorical,
    recentChanges: recentChanges(laneIssues),
    // census is engine-derived (gascity-dashboard-3ax) — the lane builder
    // has no session data and no phaseConfidence yet. deriveRunHealth
    // replaces this state in the snapshot read path.
    census: runCensusUnavailable(),
  };
  // gascity-dashboard-n6f1: spread the partial flag in (never mutate) and
  // only ever as `true`, holding the optional literal-`true` wire contract.
  return partial ? { ...summary, lanesPartial: true } : summary;
}

function isGraphV2RunGroup(rootId: string, issues: RunIssue[]): boolean {
  const root = issues.find((issue) => issue.id === rootId);
  return stringValue(root?.metadata?.['gc.formula_contract']) === 'graph.v2';
}

function runCounts(lanes: RunLane[], visible: number): RunCounts {
  const counts: RunCounts = {
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
  formula: RunLane['formula'],
): 'prReview' | 'designReview' | 'bugfix' | 'other' {
  const formulaName = runFormulaName(formula);
  if (formulaName === 'mol-adopt-pr-v2') return 'prReview';
  if (formulaName === 'mol-design-review-v2') return 'designReview';
  if (formulaName === 'mol-bug-report-flow-v2' || formulaName === 'mol-bug-report-implementation-v2') {
    return 'bugfix';
  }
  return 'other';
}

function runLane(
  rootId: string,
  issues: RunIssue[],
  feedScopes: RunFeedScopeMap,
): RunLane {
  const phase = mapRunPhase(issues);
  const updatedAt = latestUpdatedAt(issues);
  const formula = runFormula(rootId, issues);
  const formulaName = runFormulaName(formula);
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
  const progress = runProgress(stages, foundStageIndex, activeStepId, issues);

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
  const scope = runScope(rootId, issues, feedScopes);

  const lane: RunLane = {
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
    health: runHealthUnavailable(),
  };
  return lane;
}

function runRootId(issue: RunIssue): string {
  const sourceRoot = sourceRunRootId(issue);
  if (sourceRoot) return sourceRoot;

  const metadata = issue.metadata ?? {};
  const explicitRoot = stringValue(metadata['gc.root_bead_id']);
  if (explicitRoot) return explicitRoot;

  if (
    stringValue(metadata['gc.kind']) === 'run' ||
    issue.issue_type === 'molecule'
  ) {
    return issue.id;
  }

  const moleculeId = stringValue(metadata.molecule_id);
  if (moleculeId) return moleculeId;

  return issue.id;
}

function runScope(
  rootId: string,
  issues: RunIssue[],
  feedScopes: RunFeedScopeMap,
): RunScopeInfo {
  const root = issues.find((i) => i.id === rootId);
  const ordered = root
    ? [root, ...issues.filter((issue) => issue !== root)]
    : issues;
  const rootStoreRef = metadataString(ordered, 'gc.root_store_ref');
  const rootScopeKind = stringValue(root?.metadata?.['gc.scope_kind']);
  const rootScopeRef = stringValue(root?.metadata?.['gc.scope_ref']);
  // The query scope (scopeKind/scopeRef) drives the run-detail deep-link. It
  // has TWO authoritative sources, in priority order:
  //   1. Explicit bead metadata gc.scope_kind / gc.scope_ref — stamped by the
  //      supervisor at workflow-root creation. Strongest signal.
  //   2. GcFormulaRun.scope_kind / scope_ref from /v0/city/<city>/formulas/feed —
  //      the supervisor's own query-scope record for the run. Authoritative for
  //      rig-stored workflow roots surfaced by the ej9y feed-discovery path,
  //      which typically do NOT carry gc.scope_kind on the bead itself
  //      (gascity-dashboard-d3xp).
  // Critically, gc.root_store_ref is NOT a valid scope source: it is a STORAGE
  // location, not a query scope. Deriving scope from it produced a deep-link
  // the supervisor's /workflow/{id} endpoint 404s for rig-store-backed workflows
  // whose run actually resolves under the city (gascity-dashboard-sd9). When
  // both authoritative sources are absent, leave the scope unavailable so the
  // deep-link carries no scope and the workflow resolves by id under the city.
  // rootStoreRef remains a display-only field on available scopes.
  const scopeKind = parseRunScopeKind(rootScopeKind);
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

  const feedScope = feedScopes.get(rootId);
  if (feedScope !== undefined) {
    return {
      status: 'available',
      kind: feedScope.scopeKind,
      ref: feedScope.scopeRef,
      rootStoreRef: rootStoreRef || feedScope.rootStoreRef,
    };
  }

  return {
    status: 'unavailable',
    error: 'workflow scope metadata unavailable',
  };
}

type RunScopeInfo = RunLane['scope'];

function parseRunScopeKind(value: string): 'city' | 'rig' | null {
  return value === 'city' || value === 'rig' ? value : null;
}

function scopeKindFromStoreRef(rootStoreRef: string | null): 'city' | 'rig' | null {
  const [kind] = (rootStoreRef ?? '').split(':', 1);
  return parseRunScopeKind(kind ?? '');
}

function scopeRefFromStoreRef(rootStoreRef: string | null): string | null {
  const ref = rootStoreRef ?? '';
  const colon = ref.indexOf(':');
  return colon >= 0 && colon < ref.length - 1 ? ref.slice(colon + 1) : null;
}

function sourceRunRootId(issue: RunIssue): string {
  return (
    stringValue(issue.metadata?.['pr_review.run_root_id']) ||
    stringValue(issue.metadata?.['pr_review.workflow_root_id']) ||
    stringValue(issue.metadata?.['bugflow.active_run_id']) ||
    stringValue(issue.metadata?.['bugflow.implementation_run_id']) ||
    // The supervisor emits the implementation run id under the legacy
    // `workflow_id` key on bugflow issues; read it as a fallback so the
    // run link is not silently dropped when only the legacy key is set.
    stringValue(issue.metadata?.['bugflow.implementation_workflow_id']) ||
    stringValue(issue.metadata?.['design_review.run_root_id']) ||
    stringValue(issue.metadata?.['design_review.workflow_root_id'])
  );
}

function displayTitle(rootId: string, issues: RunIssue[]): string {
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

function statusCounts(issues: RunIssue[]): Record<string, number> {
  return issues.reduce<Record<string, number>>((counts, i) => {
    counts[i.status] = (counts[i.status] ?? 0) + 1;
    return counts;
  }, {});
}

function activeAssignees(issues: RunIssue[]): string[] {
  return Array.from(
    new Set(
      issues
        .filter((i) => i.status !== 'closed')
        .map((i) => i.assignee?.trim())
        .filter((a): a is string => Boolean(a)),
    ),
  ).sort();
}

function latestUpdatedAt(issues: RunIssue[]): RunLane['updatedAt'] {
  const at = issues
    .map((i) => i.updated_at)
    .filter(Boolean)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];

  return at === undefined
    ? { status: 'unavailable', error: 'workflow update time unavailable' }
    : { status: 'available', at };
}

function recentChanges(issues: RunIssue[]): RunChange[] {
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
//
// fromGcBead, stageProgress, stagesForFormula, the formula-stage helpers, and
// latestStepId / stepIssues / isPrimaryStepIssue live in ./phaseMapping.js
// (gascity-dashboard-ud6j) so the run-detail builder can compute the same
// phase ladder from its own beads without recompute drift.

function runProgress(
  stages: RunStage[],
  activeStageIndex: number,
  activeStepId: string | null,
  issues: RunIssue[],
): RunLane['progress'] {
  const stage = runStagePosition(stages, activeStageIndex);
  if (activeStepId !== null) {
    return {
      status: 'active_step',
      stepId: activeStepId,
      stage,
      attempt: runStepAttempt(issues, activeStepId),
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

function runStagePosition(
  stages: RunStage[],
  activeStageIndex: number,
): Extract<RunLane['progress'], { status: 'active_step' }>['stage'] {
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

function runStepAttempt(
  issues: RunIssue[],
  stepId: string,
): Extract<RunLane['progress'], { status: 'active_step' }>['attempt'] {
  const value = reviewRoundForIssues(stepIssues(issues, stepId));
  return value === null
    ? { status: 'unavailable', error: 'workflow step attempt unavailable' }
    : { status: 'available', value };
}

function compareLanes(a: RunLane, b: RunLane): number {
  const aTime = a.updatedAt.status === 'available' ? Date.parse(a.updatedAt.at) : 0;
  const bTime = b.updatedAt.status === 'available' ? Date.parse(b.updatedAt.at) : 0;
  return bTime - aTime || a.id.localeCompare(b.id);
}

// gascity-dashboard-3vaz (follow-up to e7hj): the title-startswith-'mol-'
// fallback only fires when the root bead is a fully-instantiated runnable
// graph.v2 root (has both gc.formula_contract='graph.v2' and gc.run_target).
// Uses the same gc.formula_contract+gc.run_target guard as
// resolveWorkflowFormulaName and reads from the SAME source (the root
// bead's own title) — a child-task title that happens to start with 'mol-'
// must never displace the root's identity on the lane card. The 'mol-'
// prefix is the lane builder's additional conservative gate: the run-detail
// page surfaces title-fallback in a warn tone (e7hj), but RunLaneFormula
// has no `source` discriminant so the lane card needs a tighter constraint
// to avoid an operator-edited descriptive title leaking as a canonical
// formula name. Phase 4 review finding (wave-3vaz-4lzn-e0hh-aqf8): prior
// implementation scanned `issues.map(...).find(...)` for any 'mol-' title,
// which would silently pick a child bead's title when the root's title
// didn't match — caught by the multi-issue regression test below.
//
// gascity-dashboard-xfb7 (sadp follow-up): closed graph.v2 roots are
// additionally excluded from the title fallback. Operators retitle roots
// post-run to descriptive summaries; a closed lane card surfacing a
// retitled string as the canonical formula is a false attribution. Mirrors
// the resolveWorkflowFormulaName closed-status guard so the lane card and
// the run-detail page stay consistent.
function runFormula(
  rootId: string,
  issues: RunIssue[],
): RunLane['formula'] {
  const explicit =
    metadataString(issues, 'pr_review.workflow_formula') ||
    metadataString(issues, 'gc.formula');
  if (explicit) return { status: 'known', name: explicit };

  const root = issues.find((i) => i.id === rootId);
  if (
    stringValue(root?.metadata?.['gc.formula_contract']) === 'graph.v2' &&
    stringValue(root?.metadata?.['gc.run_target']).length > 0 &&
    root?.status !== 'closed'
  ) {
    const rootTitle = root?.title.trim();
    if (rootTitle && rootTitle.startsWith('mol-')) {
      return { status: 'known', name: rootTitle };
    }
  }

  return { status: 'unavailable', error: 'workflow formula unavailable' };
}

function runFormulaName(formula: RunLane['formula']): string | null {
  return formula.status === 'known' ? formula.name : null;
}

function externalReference(issues: RunIssue[]): RunLane['external'] {
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

function externalUrl(issues: RunIssue[]): string | null {
  // gascity-dashboard-4x3 — defense-in-depth. Supervisor bead metadata is
  // the trust boundary; LaneCard renders this as <a href>. React does not
  // strip `javascript:` from anchor hrefs, so reject anything that is not
  // http(s) before it reaches the frontend.
  const raw =
    metadataString(issues, 'pr_review.pr_url') ||
    metadataString(issues, 'bugflow.github_issue_url');
  return raw && /^https?:\/\//i.test(raw) ? raw : null;
}

function externalLabel(issues: RunIssue[]): string | null {
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

function metadataString(issues: RunIssue[], key: string): string {
  return (
    issues.map((i) => stringValue(i.metadata?.[key])).find(Boolean) ?? ''
  );
}

// ── SourceCache wiring ────────────────────────────────────────────────────

export function emptyRunSummary(): RunSummary {
  return {
    totalActive: 0,
    totalHistorical: 0,
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
    historicalLanes: [],
    recentChanges: [],
    census: runCensusUnavailable(),
  };
}

function runCensusUnavailable(): RunSummary['census'] {
  return {
    status: 'unavailable',
    error: 'workflow health has not been derived',
  };
}

function runHealthUnavailable(): RunLane['health'] {
  return {
    status: 'unavailable',
    error: 'workflow health has not been derived',
  };
}

export interface CreateRunsSourceCacheOptions {
  /** Live source for beads. Required unless `load` is injected directly. */
  gc?: GcClient | undefined;
  /** Per-call fetch cap. Defaults to RUNS_FETCH_LIMIT. */
  limit?: number | undefined;
  now?: (() => Date) | undefined;
  loadFixture?: (() => Promise<RunSummary> | RunSummary) | undefined;
  useFixture?: boolean | undefined;
  /** Test seam: override the loader entirely (bypasses gc + filter + adapter). */
  load?: (() => Promise<RunSummary> | RunSummary) | undefined;
}

export function createRunsSourceCache(
  options: CreateRunsSourceCacheOptions = {},
): SourceCache<RunSummary> {
  const load = options.load ?? buildDefaultLoad(options);

  // sanitizeErrorMessage: null — GcClient.listBeads throws messages of
  // the shape `gc supervisor returned ${status}` which are already
  // operator-safe; collapsing them to "workflows collection failed"
  // would discard signal. Internal logic bugs in buildRunSummary
  // are operator-meaningful too. Mirrors the city collector's posture.
  return new SourceCache<RunSummary>({
    source: 'runs',
    ttlMs: RUNS_CACHE_TTL_MS,
    now: options.now,
    sanitizeErrorMessage: null,
    load,
    loadFixture: options.loadFixture,
    useFixture: options.useFixture,
  });
}

function buildDefaultLoad(
  options: CreateRunsSourceCacheOptions,
): () => Promise<RunSummary> {
  const { gc } = options;
  if (!gc) {
    throw new Error(
      'createRunsSourceCache requires either { gc } or { load } (test seam).',
    );
  }
  const limit = options.limit ?? RUNS_FETCH_LIMIT;
  return async () => {
    const { beads, feedScopes, partial } = await loadRunBeads(gc, limit);
    const filtered = beads.filter(runBeadFilter);
    const adapted = filtered.map(fromGcBead);
    return buildRunSummary(adapted, feedScopes, partial);
  };
}

interface LoadedWorkflowBeads {
  beads: GcBead[];
  /**
   * Authoritative per-root supervisor query scope harvested from the
   * /formulas/feed call alongside the rig-name discovery. Used as a
   * fallback source for lane scope when bead metadata lacks
   * gc.scope_kind / gc.scope_ref (gascity-dashboard-d3xp).
   */
  feedScopes: RunFeedScopeMap;
  /**
   * True when one or more per-rig recent-run queries rejected and were
   * skipped (gascity-dashboard-n6f1). Propagated into RunSummary.lanesPartial
   * so a degraded fan-out surfaces as a partial indicator rather than
   * collapsing the whole snapshot.
   */
  partial: boolean;
}

async function loadRunBeads(
  gc: GcClient,
  limit: number,
): Promise<LoadedWorkflowBeads> {
  // gascity-dashboard-ej9y: the city-scoped /v0/city/<city>/beads endpoint
  // does NOT include rig-stored workflow roots, contrary to this
  // collector's older assumption. Bootstrap the rig set from BOTH listBeads
  // AND /v0/city/<city>/formulas/feed so rig-stored workflows (gascity
  // maintenance, zeldascension, etc.) are visible to the dashboard. The
  // feed fetch is best-effort: if it fails, the collector falls back to
  // listBeads-only rig discovery rather than failing the whole snapshot.
  const [active, feedDiscovery] = await Promise.all([
    gc.listBeads(undefined, { limit }),
    discoverFromFeed(gc),
  ]);
  const rigNames = unionRigNames(runRigNames(active.items), feedDiscovery.rigNames);
  // gascity-dashboard-n6f1: the recent-run fan-out is best-effort per
  // source — each is settled independently so a single rig's listBeads
  // rejecting (timeout / 404 / transient flake) skips THAT source and
  // flags the snapshot partial, rather than rejecting out of load() and
  // collapsing the entire runs view to status=error. Mirrors the
  // partial-handling convention already used for the feed discovery above
  // and in collectors/cityStatus.ts. Per CLAUDE.md "Don't Swallow Errors":
  // the skip is loudly logged and surfaced as RunSummary.lanesPartial.
  const sources: Array<{ label: string; params: Parameters<GcClient['listBeads']>[1] }> = [
    ...rigNames.map((rig) => ({
      label: `rig '${rig}'`,
      params: { limit: RECENT_RUN_FETCH_LIMIT, type: 'task' as const, rig, all: true },
    })),
    {
      label: 'city molecule list',
      params: { limit: RECENT_RUN_FETCH_LIMIT, type: 'molecule' as const, all: true },
    },
  ];
  // Settle each source carrying its own label, so a rejection is reported
  // against the rig that failed without a fragile index-zip back to `sources`.
  const settled = await Promise.all(
    sources.map(async ({ label, params }) => {
      try {
        return { ok: true as const, items: (await gc.listBeads(undefined, params)).items };
      } catch (error) {
        return { ok: false as const, label, error };
      }
    }),
  );

  const recentItems: GcBead[] = [];
  let partial = false;
  for (const outcome of settled) {
    if (outcome.ok) {
      recentItems.push(...outcome.items);
      continue;
    }
    partial = true;
    logWarn(
      LOG_COMPONENT.snapshot,
      `recent-run fetch failed for ${outcome.label}: ${errorMessage(outcome.error)}; skipping (runs snapshot degraded to partial)`,
    );
  }

  return {
    beads: uniqueBeads([...active.items, ...recentItems]),
    feedScopes: feedDiscovery.scopes,
    partial,
  };
}

interface FeedDiscovery {
  rigNames: string[];
  scopes: RunFeedScopeMap;
}

/**
 * Discover rigs hosting active formula runs AND harvest the per-run
 * supervisor query scope via the cross-rig /v0/city/<city>/formulas/feed
 * endpoint. Returns empty data (not a thrown error) on failure so a
 * degraded feed doesn't black out the entire workflows view — the city
 * listBeads call covers the city-stored runs, and that path remains
 * intact even if the feed is unavailable. A degraded feed is loudly
 * logged so operators can see the soft fallback rather than silently
 * regressing to pre-ej9y behavior (per CLAUDE.md "Don't Swallow Errors"
 * + the wire-partial surfacing pattern PR #36 established).
 *
 * gascity-dashboard-d3xp: harvests scope_kind / scope_ref into a
 * per-root map alongside the rig names. Rig-stored workflow roots
 * surfaced by this discovery path typically lack gc.scope_kind on the
 * bead itself; the feed's own scope_kind is the supervisor's
 * authoritative query scope for the run and feeds the lane scope when
 * the bead has nothing explicit.
 */
async function discoverFromFeed(gc: GcClient): Promise<FeedDiscovery> {
  try {
    const runs = await gc.listFormulaRuns({
      scopeKind: 'city',
      scopeRef: gc.cityName,
    });
    const rigNames = new Set<string>();
    const scopes = new Map<string, RunFeedScope>();
    for (const run of runs.items) {
      // Filter by type so a future supervisor that broadens the feed
      // (e.g. `'session'` or `'wisp'` items) can't accidentally inject
      // unrelated rigs into the per-rig listBeads fan-out. The
      // shared JSDoc on GcFormulaRun.type already promises 'formula';
      // this enforces it at the consumer edge.
      if (run.type !== 'formula') continue;
      const storeRef = run.root_store_ref ?? null;
      const rig = scopeRefFromStoreRef(storeRef);
      if (rig !== null && scopeKindFromStoreRef(storeRef) === 'rig') {
        rigNames.add(rig);
      }
      const rootId = run.root_bead_id ?? run.workflow_id ?? null;
      const scopeKind = parseRunScopeKind(run.scope_kind);
      // Gate on SCOPE_REF_RE so a malformed supervisor scope_ref can't be
      // propagated into a lane that the routes layer would reject when the
      // user clicks the deep-link. Validation here matches the inbound gate
      // at backend/src/routes/runs.ts; SSOT regex lives in shared.
      if (
        rootId !== null &&
        scopeKind !== null &&
        run.scope_ref.length > 0 &&
        SCOPE_REF_RE.test(run.scope_ref)
      ) {
        scopes.set(rootId, {
          scopeKind,
          scopeRef: run.scope_ref,
          rootStoreRef: storeRef ?? `${scopeKind}:${run.scope_ref}`,
        });
      }
    }
    return { rigNames: [...rigNames], scopes };
  } catch (err) {
    logWarn(
      LOG_COMPONENT.snapshot,
      `feed-based rig discovery failed: ${errorMessage(err)}; falling back to listBeads-only discovery`,
    );
    return { rigNames: [], scopes: new Map() };
  }
}

/**
 * Merge rig sets from listBeads (city-stored bead provenance) and
 * /formulas/feed (cross-rig formula-run discovery). UNION (not
 * intersection or fallback) is correct because the two sources answer
 * different questions: listBeads finds rigs whose city beads reference
 * them via gc.root_store_ref; the feed finds rigs hosting active formula
 * runs regardless of where their beads live. Neither subsumes the other.
 */
function unionRigNames(a: readonly string[], b: readonly string[]): string[] {
  const all = new Set<string>();
  for (const name of a) all.add(name);
  for (const name of b) all.add(name);
  return [...all];
}

function runRigNames(beads: readonly GcBead[]): string[] {
  const names = new Set<string>();
  for (const bead of beads) {
    const rootStoreRef = stringValue(bead.metadata?.['gc.root_store_ref']);
    const storeKind = scopeKindFromStoreRef(rootStoreRef);
    const storeRef = scopeRefFromStoreRef(rootStoreRef);
    if (storeKind === 'rig' && storeRef !== null) {
      names.add(storeRef);
      continue;
    }

    const scopeKind = parseRunScopeKind(stringValue(bead.metadata?.['gc.scope_kind']));
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
