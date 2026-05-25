import type {
  WorkflowConstructKind,
  WorkflowControlBadge,
  WorkflowDisplayEdge,
  WorkflowDisplayLane,
  WorkflowDisplayNode,
  WorkflowExecutionInstance,
  GcWorkflowBead,
  GcWorkflowDep,
  GcWorkflowSnapshot,
  WorkflowNodeStatus,
  WorkflowRunDetail,
  WorkflowScopeKind,
  WorkflowSessionLink,
} from 'gas-city-dashboard-shared';

interface EnrichOptions {
  fallbackScopeRef: string;
  rigRoot?: string;
}

interface Group {
  semanticNodeId: string;
  title: string;
  kind: string;
  constructKind: WorkflowConstructKind;
  scopeRef?: string;
  loopControlNodeId?: string;
  beads: GcWorkflowBead[];
}

const HIDDEN_CONSTRUCTS = new Set<WorkflowConstructKind>([
  'scope-check',
  'workflow-finalize',
  'spec',
]);

export class UnsupportedWorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedWorkflowError';
  }
}

export function enrichWorkflowRun(
  raw: GcWorkflowSnapshot,
  opts: EnrichOptions,
): WorkflowRunDetail {
  if (!isGraphV2(raw)) {
    throw new UnsupportedWorkflowError('workflow is not a graph.v2 run');
  }

  const root = raw.root ?? firstBead(raw) ?? {};
  const rootBeadId =
    nonEmpty(raw.root_bead_id) ??
    nonEmpty(raw.rootBeadId) ??
    nonEmpty(root.id) ??
    nonEmpty(raw.workflow_id) ??
    nonEmpty(raw.workflowId) ??
    '';
  const workflowId =
    nonEmpty(raw.workflow_id) ??
    nonEmpty(raw.workflowId) ??
    rootBeadId;
  const scopeKind = parseScopeKind(raw.scope_kind ?? raw.scopeKind);
  const scopeRef =
    nonEmpty(raw.scope_ref) ??
    nonEmpty(raw.scopeRef) ??
    opts.fallbackScopeRef;

  const beads = dedupeBeads([
    ...(root.id ? [root] : []),
    ...(Array.isArray(raw.beads) ? raw.beads : []),
  ]);
  const { groups, physicalToSemantic, badgesByTarget } = groupBeads(
    beads,
    rootBeadId,
  );
  const nodes = groups.map((group) =>
    buildDisplayNode(group, badgesByTarget.get(group.semanticNodeId) ?? []),
  );
  const edges = buildEdges(raw.deps ?? [], physicalToSemantic, nodes);

  return {
    workflowId,
    rootBeadId,
    rootStoreRef:
      nonEmpty(raw.root_store_ref) ??
      nonEmpty(raw.rootStoreRef) ??
      '',
    resolvedRootStore:
      nonEmpty(raw.resolved_root_store) ??
      nonEmpty(raw.resolvedRootStore) ??
      '',
    scopeKind,
    scopeRef,
    title: nonEmpty(root.title) ?? workflowId,
    formula: workflowFormula(raw, root),
    executionPath: resolveRawExecutionPath(raw, root, beads, opts.rigRoot),
    snapshotVersion:
      typeof raw.snapshot_version === 'number'
        ? raw.snapshot_version
        : typeof raw.snapshotVersion === 'number'
          ? raw.snapshotVersion
          : 0,
    snapshotEventSeq:
      typeof raw.snapshot_event_seq === 'number'
        ? raw.snapshot_event_seq
        : typeof raw.snapshotEventSeq === 'number'
          ? raw.snapshotEventSeq
          : null,
    partial: false,
    nodes,
    edges,
    lanes: buildLanes(nodes),
  };
}

function isGraphV2(raw: GcWorkflowSnapshot): boolean {
  const root = raw.root ?? firstBead(raw);
  const candidates = [
    raw.contract,
    meta(root, 'gc.formula_contract'),
    meta(root, 'formula_contract'),
    meta(root, 'gc.contract'),
    meta(root, 'contract'),
  ];
  return candidates.some((value) => value === 'graph.v2');
}

function firstBead(raw: GcWorkflowSnapshot): GcWorkflowBead | undefined {
  return Array.isArray(raw.beads) ? raw.beads[0] : undefined;
}

function parseScopeKind(raw: string | undefined): WorkflowScopeKind {
  return raw === 'rig' ? 'rig' : 'city';
}

function workflowFormula(
  raw: GcWorkflowSnapshot,
  root: GcWorkflowBead,
): string | null {
  return (
    nonEmpty(raw.formula) ??
    meta(root, 'gc.formula') ??
    meta(root, 'formula') ??
    nonEmpty(root.ref) ??
    null
  );
}

function resolveRawExecutionPath(
  raw: GcWorkflowSnapshot,
  root: GcWorkflowBead,
  beads: GcWorkflowBead[],
  rigRoot?: string,
): string | null {
  const candidates = [
    nonEmpty(raw.cwd),
    nonEmpty(raw.work_dir),
    meta(root, 'gc.cwd'),
    meta(root, 'cwd'),
    meta(root, 'gc.work_dir'),
    meta(root, 'work_dir'),
    ...beads.flatMap((bead) => [
      meta(bead, 'gc.cwd'),
      meta(bead, 'cwd'),
      meta(bead, 'gc.work_dir'),
      meta(bead, 'work_dir'),
    ]),
    nonEmpty(raw.rig_root),
    meta(root, 'gc.rig_root'),
    meta(root, 'rig_root'),
    rigRoot,
  ];
  return candidates.find((candidate) => candidate !== undefined) ?? null;
}

function dedupeBeads(beads: GcWorkflowBead[]): GcWorkflowBead[] {
  const seen = new Set<string>();
  const out: GcWorkflowBead[] = [];
  for (const bead of beads) {
    const id = nonEmpty(bead.id);
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(bead);
  }
  return out;
}

function groupBeads(
  beads: GcWorkflowBead[],
  rootBeadId: string,
): {
  groups: Group[];
  physicalToSemantic: Map<string, string>;
  badgesByTarget: Map<string, WorkflowControlBadge[]>;
} {
  const groupsById = new Map<string, Group>();
  const physicalToSemantic = new Map<string, string>();
  const badgesByTarget = new Map<string, WorkflowControlBadge[]>();

  for (const bead of beads) {
    const beadId = nonEmpty(bead.id) ?? '';
    const constructKind = constructKindFor(bead, rootBeadId);
    const semanticNodeId = semanticNodeIdFor(bead, rootBeadId);
    physicalToSemantic.set(beadId, semanticNodeId);

    if (HIDDEN_CONSTRUCTS.has(constructKind) || constructKind === 'control') {
      const target = hiddenBadgeTarget(bead, rootBeadId);
      if (target) {
        const badges = badgesByTarget.get(target) ?? [];
        badges.push({
          id: beadId || `${target}-${constructKind}`,
          label: badgeLabelFor(constructKind),
          status: presentationStatus(bead),
        });
        badgesByTarget.set(target, badges);
      }
      continue;
    }

    const existing = groupsById.get(semanticNodeId);
    const group =
      existing ??
      {
        semanticNodeId,
        title: displayTitle(bead, semanticNodeId),
        kind: externalKind(bead, constructKind),
        constructKind,
        scopeRef: meta(bead, 'gc.scope_ref') ?? nonEmpty(bead.scope_ref),
        loopControlNodeId: loopControlNodeId(bead),
        beads: [],
      };
    group.beads.push(bead);
    if (!existing) groupsById.set(semanticNodeId, group);
  }

  return {
    groups: [...groupsById.values()],
    physicalToSemantic,
    badgesByTarget,
  };
}

function buildDisplayNode(
  group: Group,
  controlBadges: WorkflowControlBadge[],
): WorkflowDisplayNode {
  const instances = group.beads
    .map((bead, index) => buildExecutionInstance(group.semanticNodeId, bead, index))
    .sort(compareExecutionInstances);
  const visibleInstance = preferredExecutionInstance(instances);
  const iterations = new Set(
    instances
      .map((instance) => instance.iteration)
      .filter((n): n is number => typeof n === 'number'),
  );
  const visibleIteration =
    visibleInstance?.iteration ??
    (iterations.size > 0 ? Math.max(...iterations) : undefined);
  const hasHistoricalIterations =
    visibleIteration !== undefined &&
    instances.some((instance) => instance.iteration !== visibleIteration);

  for (const instance of instances) {
    const currentIteration =
      visibleIteration === undefined || instance.iteration === visibleIteration;
    instance.currentIteration = currentIteration;
    instance.historical = !currentIteration;
    instance.streamable =
      currentIteration &&
      instance.sessionLink !== null &&
      isRunningStatus(instance.status);
  }

  return {
    id: group.semanticNodeId,
    semanticNodeId: group.semanticNodeId,
    title: group.title,
    kind: group.kind,
    constructKind: group.constructKind,
    status: aggregateStatus(instances, visibleInstance),
    currentBeadId: visibleInstance?.beadId,
    scopeRef: group.scopeRef,
    loopControlNodeId: group.loopControlNodeId,
    visibleIteration,
    iterationCount: iterations.size > 0 ? iterations.size : undefined,
    hasHistoricalIterations,
    attemptBadge: attemptBadgeFor(group.beads),
    attemptCount: attemptCountFor(instances),
    activeAttempt: activeAttemptFor(instances),
    visibleExecutionInstanceId: visibleInstance?.id,
    executionInstances: instances,
    controlBadges: controlBadges.length > 0 ? controlBadges : undefined,
  };
}

function buildExecutionInstance(
  semanticNodeId: string,
  bead: GcWorkflowBead,
  index: number,
): WorkflowExecutionInstance {
  const beadId = nonEmpty(bead.id);
  const iteration = iterationFor(bead);
  const attempt = attemptFor(bead);
  const status = presentationStatus(bead);
  return {
    id:
      beadId ??
      `${semanticNodeId}:iteration-${iteration ?? 0}:attempt-${attempt ?? index}`,
    semanticNodeId,
    beadId,
    iteration,
    attempt,
    label: instanceLabel(iteration, attempt),
    status,
    sessionLink: sessionLinkFor(bead, status),
  };
}

function buildEdges(
  deps: GcWorkflowDep[],
  physicalToSemantic: Map<string, string>,
  nodes: WorkflowDisplayNode[],
): WorkflowDisplayEdge[] {
  const visible = new Set(nodes.map((node) => node.id));
  const seen = new Set<string>();
  const edges: WorkflowDisplayEdge[] = [];
  for (const dep of deps) {
    const rawFrom = nonEmpty(dep.from) ?? nonEmpty(dep.depends_on_id);
    const rawTo = nonEmpty(dep.to) ?? nonEmpty(dep.issue_id);
    if (!rawFrom || !rawTo) continue;
    const from = physicalToSemantic.get(rawFrom) ?? rawFrom;
    const to = physicalToSemantic.get(rawTo) ?? rawTo;
    if (from === to || !visible.has(from) || !visible.has(to)) continue;
    const kind = nonEmpty(dep.kind) ?? nonEmpty(dep.type);
    const key = `${from}->${to}:${kind ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to, kind });
  }
  return edges;
}

function buildLanes(nodes: WorkflowDisplayNode[]): WorkflowDisplayLane[] {
  const byScope = new Map<string, WorkflowDisplayLane>();
  for (const node of nodes) {
    const scope = node.scopeRef ?? '__workflow';
    const existing =
      byScope.get(scope) ??
      {
        id: scope,
        label: scope === '__workflow' ? 'Workflow' : scope,
        nodeIds: [],
      };
    existing.nodeIds.push(node.id);
    byScope.set(scope, existing);
  }
  return [...byScope.values()];
}

function semanticNodeIdFor(bead: GcWorkflowBead, rootBeadId: string): string {
  const beadId = nonEmpty(bead.id);
  if (beadId && beadId === rootBeadId) return rootBeadId;
  const explicit = meta(bead, 'gc.logical_bead_id') ?? nonEmpty(bead.logical_bead_id);
  if (explicit) return externalizeId(explicit);
  const stepId = meta(bead, 'gc.step_id');
  if (stepId) return externalizeId(stepId);
  const ref = normalizedStepRef(bead);
  if (ref) {
    const parts = ref.split('.').filter(Boolean);
    const last = parts.at(-1);
    if (last) return externalizeId(last);
  }
  return externalizeId(beadId ?? 'workflow-node');
}

function hiddenBadgeTarget(
  bead: GcWorkflowBead,
  rootBeadId: string,
): string | null {
  const kind = constructKindFor(bead, rootBeadId);
  if (kind === 'workflow-finalize') return rootBeadId;
  const ref = normalizedStepRef(bead);
  if (!ref) return null;
  const stripped = ref.replace(/-scope-check$/, '').replace(/\.scope-check$/, '');
  const parts = stripped.split('.').filter(Boolean);
  return externalizeId(parts.at(-1) ?? stripped);
}

function constructKindFor(
  bead: GcWorkflowBead,
  rootBeadId: string,
): WorkflowConstructKind {
  const beadId = nonEmpty(bead.id);
  if (beadId && beadId === rootBeadId) return 'workflow-root';
  const explicit = meta(bead, 'constructKind');
  if (isConstructKind(explicit)) return explicit;
  const kind = rawKind(bead);
  switch (kind) {
    case 'ralph':
      return 'check-loop';
    case 'retry':
      return 'retry';
    case 'scope':
    case 'epic':
    case 'body':
      return 'scope';
    case 'fanout':
      return 'fanout';
    case 'condition':
      return 'condition';
    case 'expand':
    case 'expansion':
      return 'expansion';
    case 'scope-check':
      return 'scope-check';
    case 'workflow-finalize':
      return 'workflow-finalize';
    case 'spec':
      return 'spec';
    case 'cleanup':
      return 'control';
    default:
      return 'step';
  }
}

function rawKind(bead: GcWorkflowBead): string {
  return (
    meta(bead, 'gc.kind') ??
    meta(bead, 'gc.original_kind') ??
    nonEmpty(bead.kind) ??
    ''
  );
}

function externalKind(
  bead: GcWorkflowBead,
  constructKind: WorkflowConstructKind,
): string {
  if (constructKind === 'check-loop') return 'check-loop';
  const kind = rawKind(bead);
  return kind === 'ralph' ? 'check-loop' : kind || constructKind;
}

function isConstructKind(
  value: string | undefined,
): value is WorkflowConstructKind {
  return (
    value === 'workflow-root' ||
    value === 'step' ||
    value === 'retry' ||
    value === 'check-loop' ||
    value === 'scope' ||
    value === 'condition' ||
    value === 'fanout' ||
    value === 'expansion' ||
    value === 'scope-check' ||
    value === 'workflow-finalize' ||
    value === 'spec' ||
    value === 'control' ||
    value === 'unknown'
  );
}

function presentationStatus(bead: GcWorkflowBead): WorkflowNodeStatus {
  const raw = nonEmpty(bead.status) ?? '';
  const outcome = meta(bead, 'gc.outcome');
  if (raw === 'closed' || raw === 'completed' || raw === 'done') {
    if (outcome === 'fail' || outcome === 'failed') return 'failed';
    if (outcome === 'skipped') return 'skipped';
    return 'completed';
  }
  if (raw === 'in_progress' || raw === 'active' || raw === 'running') {
    return 'active';
  }
  if (raw === 'blocked') return 'blocked';
  if (raw === 'ready') return 'ready';
  if (raw === 'failed') return 'failed';
  if (raw === 'skipped') return 'skipped';
  return 'pending';
}

function aggregateStatus(
  instances: WorkflowExecutionInstance[],
  visibleInstance: WorkflowExecutionInstance | undefined,
): WorkflowNodeStatus {
  if (instances.some((instance) => isRunningStatus(instance.status))) {
    return 'active';
  }
  if (visibleInstance?.status) return visibleInstance.status;
  return 'pending';
}

function isRunningStatus(status: WorkflowNodeStatus | undefined): boolean {
  return status === 'active' || status === 'running';
}

function preferredExecutionInstance(
  instances: WorkflowExecutionInstance[],
): WorkflowExecutionInstance | undefined {
  return [...instances].sort(compareExecutionInstances).at(-1);
}

function compareExecutionInstances(
  left: WorkflowExecutionInstance,
  right: WorkflowExecutionInstance,
): number {
  return (
    (left.iteration ?? 0) - (right.iteration ?? 0) ||
    (left.attempt ?? 0) - (right.attempt ?? 0) ||
    (left.beadId ?? left.id).localeCompare(right.beadId ?? right.id)
  );
}

function attemptBadgeFor(beads: GcWorkflowBead[]): string | undefined {
  const maxAttempts = beads
    .map((bead) => meta(bead, 'gc.max_attempts'))
    .find((value) => value !== undefined);
  const max = maxAttempts ? Number.parseInt(maxAttempts, 10) : NaN;
  if (!Number.isFinite(max) || max <= 0) return undefined;
  const attempts = new Set(beads.map(attemptFor).filter(isNumber));
  return `${Math.max(attempts.size, 1)}/${max}`;
}

function attemptCountFor(instances: WorkflowExecutionInstance[]): number | undefined {
  const attempts = new Set(instances.map((instance) => instance.attempt).filter(isNumber));
  return attempts.size > 0 ? attempts.size : undefined;
}

function activeAttemptFor(instances: WorkflowExecutionInstance[]): number | undefined {
  return instances.find((instance) => isRunningStatus(instance.status))?.attempt;
}

function instanceLabel(
  iteration: number | undefined,
  attempt: number | undefined,
): string | undefined {
  if (iteration !== undefined && attempt !== undefined) {
    return `iteration ${iteration}, attempt ${attempt}`;
  }
  if (iteration !== undefined) return `iteration ${iteration}`;
  if (attempt !== undefined) return `attempt ${attempt}`;
  return undefined;
}

function sessionLinkFor(
  bead: GcWorkflowBead,
  status: WorkflowNodeStatus,
): WorkflowSessionLink | null {
  if (!isRunningStatus(status) && status !== 'completed' && status !== 'done') {
    return null;
  }
  const sessionId =
    meta(bead, 'session_id') ??
    meta(bead, 'gc.session_id') ??
    meta(bead, 'gc.sessionId') ??
    nonEmpty(bead.assignee);
  const sessionName =
    meta(bead, 'session_name') ??
    meta(bead, 'gc.session_name') ??
    meta(bead, 'gc.sessionName') ??
    sessionId;
  if (!sessionId && !sessionName) return null;
  const assignee = meta(bead, 'assignee') ?? nonEmpty(bead.assignee) ?? sessionName ?? sessionId ?? '';
  return {
    sessionId: sessionId ?? sessionName ?? '',
    sessionName: sessionName ?? sessionId ?? '',
    assignee,
    rigId: meta(bead, 'mc_rig_id') ?? meta(bead, 'rig_id'),
  };
}

function displayTitle(bead: GcWorkflowBead, fallback: string): string {
  return nonEmpty(bead.title) ?? fallback.replace(/[-_]/g, ' ');
}

function badgeLabelFor(kind: WorkflowConstructKind): string {
  switch (kind) {
    case 'scope-check':
      return 'scope check';
    case 'workflow-finalize':
      return 'finalize';
    default:
      return kind.replace(/-/g, ' ');
  }
}

function loopControlNodeId(bead: GcWorkflowBead): string | undefined {
  const ref = normalizedStepRef(bead);
  if (!ref || !ref.includes('.iteration.')) return undefined;
  const parent = ref.slice(0, ref.indexOf('.iteration.'));
  const parts = parent.split('.').filter(Boolean);
  const last = parts.at(-1);
  return last ? externalizeId(last) : undefined;
}

function iterationFor(bead: GcWorkflowBead): number | undefined {
  return (
    numericMeta(bead, 'gc.iteration') ??
    numericRefSegment(bead, 'iteration') ??
    numericRefSegment(bead, 'run')
  );
}

function attemptFor(bead: GcWorkflowBead): number | undefined {
  return (
    numericMeta(bead, 'gc.attempt') ??
    numericField(bead.attempt) ??
    numericRefSegment(bead, 'attempt')
  );
}

function normalizedStepRef(bead: GcWorkflowBead): string | null {
  const ref =
    meta(bead, 'gc.step_ref') ??
    meta(bead, 'step_ref') ??
    nonEmpty(bead.step_ref);
  return ref ?? null;
}

function numericRefSegment(
  bead: GcWorkflowBead,
  marker: string,
): number | undefined {
  const ref = normalizedStepRef(bead);
  if (!ref) return undefined;
  const parts = ref.split('.');
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (parts[i] !== marker) continue;
    const parsed = Number.parseInt(parts[i + 1] ?? '', 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function numericMeta(bead: GcWorkflowBead, key: string): number | undefined {
  return numericField(meta(bead, key));
}

function numericField(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function meta(bead: GcWorkflowBead | undefined, key: string): string | undefined {
  const value = bead?.metadata?.[key];
  if (typeof value === 'string') return nonEmpty(value);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function isNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function externalizeId(id: string): string {
  return id.replace(/\bralph\b/gi, 'check-loop');
}
