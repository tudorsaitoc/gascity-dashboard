import type {
  GcWorkflowDep,
  GcWorkflowSnapshot,
  WorkflowDisplayEdge,
  WorkflowDisplayNode,
} from 'gas-city-dashboard-shared';
import { externalizeId, nonEmpty } from './bead-fields.js';

export function buildWorkflowDisplayEdges(
  raw: GcWorkflowSnapshot,
  physicalToSemantic: Map<string, string>,
  nodes: WorkflowDisplayNode[],
): WorkflowDisplayEdge[] {
  const logicalEdges = projectEdges(raw.logical_edges ?? [], physicalToSemantic, nodes);
  if (logicalEdges.length > 0) return logicalEdges;
  return projectEdges(
    raw.deps ?? [],
    physicalToSemantic,
    nodes,
    bridgeableScopeCheckIds(raw),
  );
}

function projectEdges(
  deps: GcWorkflowDep[],
  physicalToSemantic: Map<string, string>,
  nodes: WorkflowDisplayNode[],
  bridgeableHiddenIds = new Set<string>(),
): WorkflowDisplayEdge[] {
  const visible = new Set(
    nodes
      .filter((node) => node.visibleInGraph !== false)
      .map((node) => node.id),
  );
  const outgoing = outgoingDeps(deps);
  const seen = new Set<string>();
  const edges: WorkflowDisplayEdge[] = [];
  for (const dep of deps) {
    const rawFrom = nonEmpty(dep.from);
    const rawTo = nonEmpty(dep.to);
    if (!rawFrom || !rawTo) continue;
    if (nonEmpty(dep.kind) === 'tracks') continue;
    const from = physicalToSemantic.get(rawFrom) ?? externalizeId(rawFrom);
    const to = physicalToSemantic.get(rawTo) ?? externalizeId(rawTo);
    const kind = nonEmpty(dep.kind);
    if (visible.has(from) && visible.has(to)) {
      pushEdge(edges, seen, from, to, kind);
      continue;
    }
    if (visible.has(from) && bridgeableHiddenIds.has(rawTo)) {
      bridgeHiddenEdges({
        edges,
        seen,
        source: from,
        currentRawId: rawTo,
        outgoing,
        visible,
        bridgeableHiddenIds,
        physicalToSemantic,
        inheritedKind: kind,
      });
    }
  }
  return edges;
}

function bridgeHiddenEdges({
  edges,
  seen,
  source,
  currentRawId,
  outgoing,
  visible,
  bridgeableHiddenIds,
  physicalToSemantic,
  inheritedKind,
  visited = new Set<string>(),
}: {
  edges: WorkflowDisplayEdge[];
  seen: Set<string>;
  source: string;
  currentRawId: string;
  outgoing: Map<string, GcWorkflowDep[]>;
  visible: Set<string>;
  bridgeableHiddenIds: Set<string>;
  physicalToSemantic: Map<string, string>;
  inheritedKind?: string;
  visited?: Set<string>;
}): void {
  if (visited.has(currentRawId)) return;
  visited.add(currentRawId);
  for (const dep of outgoing.get(currentRawId) ?? []) {
    const rawTo = nonEmpty(dep.to);
    if (!rawTo) continue;
    const kind = nonEmpty(dep.kind);
    if (kind === 'tracks') continue;
    const target = physicalToSemantic.get(rawTo) ?? externalizeId(rawTo);
    const edgeKind = kind ?? inheritedKind;
    if (visible.has(target)) {
      pushEdge(edges, seen, source, target, edgeKind);
    } else if (bridgeableHiddenIds.has(rawTo)) {
      bridgeHiddenEdges({
        edges,
        seen,
        source,
        currentRawId: rawTo,
        outgoing,
        visible,
        bridgeableHiddenIds,
        physicalToSemantic,
        inheritedKind: edgeKind,
        visited,
      });
    }
  }
}

function pushEdge(
  edges: WorkflowDisplayEdge[],
  seen: Set<string>,
  from: string,
  to: string,
  kind?: string,
): void {
  if (from === to) return;
  const key = `${from}->${to}:${kind ?? ''}`;
  if (seen.has(key)) return;
  seen.add(key);
  edges.push(kind ? { from, to, kind } : { from, to });
}

function outgoingDeps(deps: GcWorkflowDep[]): Map<string, GcWorkflowDep[]> {
  const out = new Map<string, GcWorkflowDep[]>();
  for (const dep of deps) {
    const from = nonEmpty(dep.from);
    const to = nonEmpty(dep.to);
    if (!from || !to) continue;
    out.set(from, [...(out.get(from) ?? []), dep]);
  }
  return out;
}

function bridgeableScopeCheckIds(raw: GcWorkflowSnapshot): Set<string> {
  const ids = new Set<string>();
  for (const bead of raw.beads ?? []) {
    const id = nonEmpty(bead.id);
    if (!id) continue;
    const kind = nonEmpty(bead.metadata?.['gc.kind']) ?? nonEmpty(bead.kind);
    if (kind === 'scope-check') ids.add(id);
  }
  return ids;
}
