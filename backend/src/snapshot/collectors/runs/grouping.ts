import {
  type RunCounts,
  type RunLane,
  type RunSummary,
} from 'gas-city-dashboard-shared';

import { fromRootMetadataScope } from '../../../lib/run-scope.js';
import { resolveRunFormulaIdentity } from '../../../runs/formula-name.js';
import { MAX_VISIBLE_ACTIVE_LANES } from './constants.js';
import type { RunFeedScopeMap } from './types.js';
import {
  activeAssignees,
  compareLanes,
  displayTitle,
  externalReference,
  latestUpdatedAt,
  metadataString,
  recentChanges,
  runCensusUnavailable,
  runHealthUnavailable,
  statusCounts,
} from './presentation.js';
import { runProgress } from './progress.js';
import {
  isPrimaryStepIssue,
  latestStepId,
  mapRunPhase,
  stageProgress,
  stagesForFormula,
  stringValue,
  type RunIssue,
} from '../phaseMapping.js';

export function buildRunSummary(
  issues: RunIssue[],
  feedScopes: RunFeedScopeMap = new Map(),
  partial = false,
): RunSummary {
  const groups = new Map<string, RunIssue[]>();

  for (const issue of issues) {
    const rootId = runRootId(issue);
    const group = groups.get(rootId) ?? [];
    group.push(issue);
    groups.set(rootId, group);
  }

  const runGroups = Array.from(groups.entries()).filter(([rootId, groupIssues]) =>
    isGraphV2RunGroup(rootId, groupIssues),
  );
  const laneIssues = runGroups.flatMap(([, groupIssues]) => groupIssues);
  const sortedLanes = runGroups
    .map(([rootId, groupIssues]) => runLane(rootId, groupIssues, feedScopes))
    .sort(compareLanes);

  const activeLanes = sortedLanes.filter((lane) => lane.phase !== 'complete');
  const historicalLanes = sortedLanes.filter((lane) => lane.phase === 'complete');
  const visibleActive = activeLanes.slice(0, MAX_VISIBLE_ACTIVE_LANES);

  const summary: RunSummary = {
    totalActive: activeLanes.length,
    totalHistorical: historicalLanes.length,
    runCounts: runCounts(activeLanes, visibleActive.length),
    lanes: visibleActive,
    // Historical lanes ship uncapped (gascity-dashboard-l9q9): the frontend
    // renders a preview and reveals the rest in place via a show-more toggle,
    // so the wire must carry the full completed set (bounded by the run-fetch
    // limit). Active lanes stay capped — they're the live, ambient surface.
    historicalLanes,
    recentChanges: recentChanges(laneIssues),
    census: runCensusUnavailable(),
  };
  return partial ? { ...summary, lanesPartial: true } : summary;
}

function isGraphV2RunGroup(rootId: string, issues: RunIssue[]): boolean {
  const root = issues.find((issue) => issue.id === rootId);
  return stringValue(root?.metadata?.['gc.formula_contract']) === 'graph.v2';
}

export function runCounts(lanes: RunLane[], visible: number): RunCounts {
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

export function runKind(
  formula: RunLane['formula'],
): 'prReview' | 'designReview' | 'bugfix' | 'other' {
  const formulaName = runFormulaName(formula);
  if (formulaName === 'mol-adopt-pr-v2') return 'prReview';
  if (formulaName === 'mol-design-review-v2') return 'designReview';
  if (
    formulaName === 'mol-bug-report-flow-v2' ||
    formulaName === 'mol-bug-report-implementation-v2'
  ) {
    return 'bugfix';
  }
  return 'other';
}

export function runLane(
  rootId: string,
  issues: RunIssue[],
  feedScopes: RunFeedScopeMap,
): RunLane {
  const phase = mapRunPhase(issues);
  const updatedAt = latestUpdatedAt(issues);
  const formula = runFormula(rootId, issues);
  const formulaName = runFormulaName(formula);
  const stages = stageProgress(phase, formulaName, issues);
  const foundStageIndex = stages.findIndex((stage) => stage.status === 'active');
  const activeStage = foundStageIndex >= 0 ? stages[foundStageIndex] : undefined;

  const primaryInProgress = issues.filter(
    (issue) => isPrimaryStepIssue(issue) && issue.status === 'in_progress',
  );
  const activeStepId = latestStepId(primaryInProgress);
  const progress = runProgress(stages, foundStageIndex, activeStepId, issues);

  const formulaStages = stagesForFormula(formulaName);
  const formulaStageResolved =
    formulaStages.length > 0 &&
    progress.status === 'active_step' &&
    formulaStages.some((stage) => stage.steps.includes(progress.stepId));
  const scope = runScope(rootId, issues, feedScopes);

  return {
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
}

export function runRootId(issue: RunIssue): string {
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
): RunLane['scope'] {
  const root = issues.find((issue) => issue.id === rootId);
  const ordered = root
    ? [root, ...issues.filter((issue) => issue !== root)]
    : issues;
  const rootStoreRef = metadataString(ordered, 'gc.root_store_ref');
  const metadataScope = fromRootMetadataScope({
    ...(root?.metadata ?? {}),
    ...(rootStoreRef ? { 'gc.root_store_ref': rootStoreRef } : {}),
    'gc.scope_ref':
      stringValue(root?.metadata?.['gc.scope_ref']) ||
      metadataString(ordered, 'gc.scope_ref'),
  });

  if (metadataScope !== null) {
    return {
      status: 'available',
      kind: metadataScope.scopeKind,
      ref: metadataScope.scopeRef,
      rootStoreRef: metadataScope.rootStoreRef,
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
    error: 'run scope metadata unavailable',
  };
}

function sourceRunRootId(issue: RunIssue): string {
  return (
    stringValue(issue.metadata?.['pr_review.run_root_id']) ||
    stringValue(issue.metadata?.['pr_review.workflow_root_id']) ||
    stringValue(issue.metadata?.['bugflow.active_run_id']) ||
    stringValue(issue.metadata?.['bugflow.implementation_run_id']) ||
    stringValue(issue.metadata?.['bugflow.implementation_workflow_id']) ||
    stringValue(issue.metadata?.['design_review.run_root_id']) ||
    stringValue(issue.metadata?.['design_review.workflow_root_id'])
  );
}

function runFormula(
  rootId: string,
  issues: RunIssue[],
): RunLane['formula'] {
  const root = issues.find((issue) => issue.id === rootId);
  const resolved = resolveRunFormulaIdentity('lane', { root, issues });
  if (resolved.name !== null) return { status: 'known', name: resolved.name };

  return { status: 'unavailable', error: 'run formula unavailable' };
}

function runFormulaName(formula: RunLane['formula']): string | null {
  return formula.status === 'known' ? formula.name : null;
}
