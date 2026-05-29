export type WorkflowScopeKind = 'city' | 'rig';

/**
 * Validation pattern for a workflow `scope_ref` query value. Lives in shared so
 * the backend route guard and the frontend deep-link parser validate against
 * one source of truth — a wire rule that crosses the boundary must not be
 * copy-pasted on each side (they would silently drift).
 */
export const SCOPE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;

export type WorkflowNodeStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'active'
  | 'done'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'skipped';

export type WorkflowConstructKind =
  | 'workflow-root'
  | 'step'
  | 'retry'
  | 'check-loop'
  | 'scope'
  | 'condition'
  | 'fanout'
  | 'expansion'
  | 'scope-check'
  | 'workflow-finalize'
  | 'spec'
  | 'control'
  | 'unknown';

export interface WorkflowSessionLink {
  sessionId: string;
  sessionName: string;
  assignee: string;
}

export type WorkflowIteration =
  | { kind: 'base' }
  | { kind: 'loop'; value: number };

export type WorkflowAttempt =
  | { kind: 'untracked' }
  | { kind: 'attempt'; value: number };

export type WorkflowSessionAttachment =
  | { kind: 'attached'; link: WorkflowSessionLink; streamable: boolean }
  | { kind: 'none'; reason: 'not_started' | 'session_unresolved' };

export interface WorkflowExecutionInstance {
  id: string;
  semanticNodeId: string;
  beadId: string;
  iteration: WorkflowIteration;
  attempt: WorkflowAttempt;
  label: string;
  status: WorkflowNodeStatus;
  session: WorkflowSessionAttachment;
  currentIteration: boolean;
  historical: boolean;
}

export interface WorkflowControlBadge {
  id: string;
  label: string;
  status: WorkflowNodeStatus;
}

export interface WorkflowDisplayNode {
  id: string;
  semanticNodeId: string;
  title: string;
  kind: string;
  constructKind: WorkflowConstructKind;
  status: WorkflowNodeStatus;
  currentBeadId: string;
  scope: WorkflowNodeScope;
  /** False when this semantic node is transcript history only and should not render in the left graph. */
  visibleInGraph: boolean;
  /** True when all execution instances are from older loop iterations or stale expansion output. */
  historicalOnly: boolean;
  iterationSummary: WorkflowIterationSummary;
  attemptSummary: WorkflowAttemptSummary;
  visibleExecutionInstanceId: string;
  executionInstances: WorkflowExecutionInstance[];
  controlBadges: WorkflowControlBadge[];
}

export type WorkflowNodeScope =
  | { kind: 'workflow' }
  | { kind: 'scoped'; ref: string };

export type WorkflowIterationSummary =
  | { kind: 'single' }
  | {
      kind: 'stacked';
      visibleIteration: number;
      iterationCount: number;
      control: { kind: 'known'; id: string } | { kind: 'unknown' };
    };

export type WorkflowAttemptSummary =
  | { kind: 'none' }
  | {
      kind: 'tracked';
      count: number;
      badge: { kind: 'bounded'; label: string } | { kind: 'count-only' };
      active: { kind: 'running'; value: number } | { kind: 'idle' };
    };

export interface WorkflowDisplayEdge {
  from: string;
  to: string;
  kind: string;
}

export interface WorkflowDisplayLane {
  id: string;
  label: string;
  nodeIds: string[];
}

export interface WorkflowRunProgress {
  snapshotVersion: number;
  snapshotEventSeq: WorkflowSnapshotSequence;
  partial: boolean;
  totalNodeCount: number;
  visibleNodeCount: number;
  edgeCount: number;
  executionInstanceCount: number;
  sessionLinkCount: number;
  streamableSessionCount: number;
  streamableSessionIds: string[];
  statusCounts: Partial<Record<WorkflowNodeStatus, number>>;
  allStatusCounts: Partial<Record<WorkflowNodeStatus, number>>;
}

export interface WorkflowRunDetail {
  workflowId: string;
  rootBeadId: string;
  rootStoreRef: string;
  resolvedRootStore: string;
  scopeKind: WorkflowScopeKind;
  scopeRef: string;
  title: string;
  formula: WorkflowFormula;
  executionPath: WorkflowExecutionPath;
  snapshotVersion: number;
  snapshotEventSeq: WorkflowSnapshotSequence;
  partial: boolean;
  progress: WorkflowRunProgress;
  nodes: WorkflowDisplayNode[];
  edges: WorkflowDisplayEdge[];
  lanes: WorkflowDisplayLane[];
}

/**
 * `source` records where the formula `name` came from:
 *
 * - `metadata` — the supervisor reported the formula identity. Either the
 *   workflow root carries `gc.formula`, OR the formula-detail fetch from
 *   the supervisor returned a name (the supervisor is canonical even when
 *   the root metadata key is absent).
 * - `title_fallback` — the supervisor did NOT set `gc.formula` on a
 *   graph.v2 root and the formula-detail fetch yielded nothing, so the
 *   resolver derived the name from the bead title. Per the project's
 *   "Don't Swallow Errors" posture this case is surfaced to the operator
 *   in a warn tone rather than rendered as if it were canonical metadata.
 *   See gascity-dashboard-e7hj for the precedent.
 */
export type WorkflowFormula =
  | { kind: 'known'; name: string; source: WorkflowFormulaSource }
  | { kind: 'unavailable'; reason: 'missing_formula_metadata' | 'formula_detail_unavailable' };

export type WorkflowFormulaSource = 'metadata' | 'title_fallback';

export type WorkflowExecutionPath =
  | { kind: 'known'; path: string }
  | { kind: 'unavailable'; reason: 'missing_cwd_and_rig_root' };

export type WorkflowSnapshotSequence =
  | { kind: 'known'; seq: number }
  | { kind: 'unavailable'; reason: 'supervisor_omitted' };

export type WorkflowDiffKind = 'ok' | 'not_git' | 'path_unknown' | 'error';

export type WorkflowChangedFileKind =
  | 'code'
  | 'test'
  | 'docs'
  | 'config'
  | 'other';

export interface WorkflowChangedFile {
  path: string;
  status: string;
  kind: WorkflowChangedFileKind;
}

interface WorkflowDiffBase {
  rootPath: WorkflowDiffRootPath;
  status: string[];
  changedFiles: WorkflowChangedFile[];
  unstagedDiff: string;
  stagedDiff: string;
  truncated: boolean;
}

export type WorkflowDiffResponse =
  | (WorkflowDiffBase & { kind: 'ok' })
  | (WorkflowDiffBase & { kind: 'not_git' | 'path_unknown' })
  | (WorkflowDiffBase & { kind: 'error'; error: string });

export type WorkflowDiffRootPath =
  | { kind: 'known'; path: string }
  | { kind: 'unavailable'; reason: 'path_unknown' | 'not_git' | 'error' };
