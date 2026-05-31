import type {
  GcRunBead,
  RunControlBadge,
} from 'gas-city-dashboard-shared';
import {
  externalizeId,
  meta,
  nonEmpty,
  normalizedStepRef,
} from './bead-fields.js';
import type { RunNodeGroup } from './execution-instances.js';
import {
  badgeLabelFor,
  constructKindFor,
  displayTitleFor,
  externalKindFor,
  hiddenBadgeTargetFor,
  isHiddenConstruct,
  loopControlNodeIdFor,
  semanticNodeIdFor,
} from './node-shape.js';
import { presentationStatus } from './status.js';

export interface RunBeadGroups {
  groups: RunNodeGroup[];
  physicalToSemantic: Map<string, string>;
  badgesByTarget: Map<string, RunControlBadge[]>;
}

export function groupRunBeads(
  beads: GcRunBead[],
  rootBeadId: string,
): RunBeadGroups {
  const groupsById = new Map<string, RunNodeGroup>();
  const physicalToSemantic = new Map<string, string>();
  const badgesByTarget = new Map<string, RunControlBadge[]>();
  const physicalLogicalTargets = referencedPhysicalLogicalTargets(beads);
  const semanticIds = resolveSemanticIds(beads, rootBeadId, physicalLogicalTargets);
  const badgeTargetAliases = buildBadgeTargetAliases(
    beads,
    rootBeadId,
    semanticIds,
    physicalLogicalTargets,
  );

  for (const bead of beads) {
    const beadId = nonEmpty(bead.id) ?? '';
    const constructKind = constructKindFor(bead, rootBeadId);
    const semanticNodeId = semanticIds.get(bead) ?? semanticNodeIdFor(bead, rootBeadId);
    physicalToSemantic.set(beadId, semanticNodeId);

    if (isHiddenConstruct(constructKind)) {
      const target = hiddenBadgeTargetFor(bead, rootBeadId);
      const resolvedTarget = resolveBadgeTarget(bead, rootBeadId, badgeTargetAliases, target);
      if (resolvedTarget) {
        const badges = badgesByTarget.get(resolvedTarget) ?? [];
        badges.push({
          id: beadId || `${resolvedTarget}-${constructKind}`,
          label: badgeLabelFor(constructKind),
          status: presentationStatus(bead),
        });
        badgesByTarget.set(resolvedTarget, badges);
      }
      continue;
    }

    const existing = groupsById.get(semanticNodeId);
    const group =
      existing ??
      buildRunNodeGroup(bead, semanticNodeId, constructKind);
    if (existing && shouldPromoteGroupShape(existing.constructKind, constructKind)) {
      existing.title = displayTitleFor(bead, semanticNodeId);
      existing.kind = externalKindFor(bead, constructKind);
      existing.constructKind = constructKind;
      assignOptional(existing, 'scopeRef', meta(bead, 'gc.scope_ref') ?? nonEmpty(bead.scope_ref));
      assignOptional(existing, 'loopControlNodeId', loopControlNodeIdFor(bead));
    }
    group.beads.push(bead);
    if (!existing) groupsById.set(semanticNodeId, group);
  }

  return {
    groups: [...groupsById.values()],
    physicalToSemantic,
    badgesByTarget,
  };
}

function buildRunNodeGroup(
  bead: GcRunBead,
  semanticNodeId: string,
  constructKind: RunNodeGroup['constructKind'],
): RunNodeGroup {
  const group: RunNodeGroup = {
    semanticNodeId,
    title: displayTitleFor(bead, semanticNodeId),
    kind: externalKindFor(bead, constructKind),
    constructKind,
    beads: [] as GcRunBead[],
  };
  assignOptional(group, 'scopeRef', meta(bead, 'gc.scope_ref') ?? nonEmpty(bead.scope_ref));
  assignOptional(group, 'loopControlNodeId', loopControlNodeIdFor(bead));
  return group;
}

function assignOptional<K extends 'scopeRef' | 'loopControlNodeId'>(
  group: RunNodeGroup,
  key: K,
  value: RunNodeGroup[K] | undefined,
): void {
  if (value === undefined) {
    delete group[key];
    return;
  }
  group[key] = value;
}

function shouldPromoteGroupShape(
  current: RunNodeGroup['constructKind'],
  candidate: RunNodeGroup['constructKind'],
): boolean {
  if (current !== 'step') return false;
  return candidate !== 'step' && !isHiddenConstruct(candidate);
}

function resolveSemanticIds(
  beads: readonly GcRunBead[],
  rootBeadId: string,
  physicalLogicalTargets: ReadonlySet<string>,
): Map<GcRunBead, string> {
  const baseIds = new Map<GcRunBead, string>();
  const identitiesByBase = new Map<string, Set<string>>();

  for (const bead of beads) {
    const constructKind = constructKindFor(bead, rootBeadId);
    if (isHiddenConstruct(constructKind)) continue;
    const base = groupingBaseSemanticId(bead, rootBeadId, physicalLogicalTargets);
    const identity =
      duplicateResolutionIdentity(bead, rootBeadId, base, physicalLogicalTargets) ?? base;
    baseIds.set(bead, base);
    identitiesByBase.set(base, new Set([...(identitiesByBase.get(base) ?? []), identity]));
  }

  const resolved = new Map<GcRunBead, string>();
  for (const bead of beads) {
    const base = baseIds.get(bead) ?? semanticNodeIdFor(bead, rootBeadId);
    const identities = identitiesByBase.get(base);
    const identity = duplicateResolutionIdentity(
      bead,
      rootBeadId,
      base,
      physicalLogicalTargets,
    );
    resolved.set(bead, identities && identities.size > 1 && identity ? identity : base);
  }
  return resolved;
}

function groupingBaseSemanticId(
  bead: GcRunBead,
  rootBeadId: string,
  physicalLogicalTargets: ReadonlySet<string>,
): string {
  const beadId = nonEmpty(bead.id);
  if (beadId && beadId === rootBeadId) return rootBeadId;
  const explicit = meta(bead, 'gc.logical_bead_id') ?? nonEmpty(bead.logical_bead_id);
  if (explicit) return externalizeId(explicit);
  const constructKind = constructKindFor(bead, rootBeadId);
  if (
    (constructKind === 'check-loop' || constructKind === 'retry') &&
    beadId &&
    physicalLogicalTargets.has(beadId)
  ) {
    return externalizeId(beadId);
  }
  return semanticNodeIdFor(bead, rootBeadId);
}

function duplicateResolutionIdentity(
  bead: GcRunBead,
  rootBeadId: string,
  base: string,
  physicalLogicalTargets: ReadonlySet<string>,
): string | undefined {
  const beadId = nonEmpty(bead.id);
  if (beadId && physicalLogicalTargets.has(beadId) && externalizeId(beadId) === base) {
    return base;
  }
  return stableSemanticIdentity(bead, rootBeadId);
}

function buildBadgeTargetAliases(
  beads: readonly GcRunBead[],
  rootBeadId: string,
  semanticIds: Map<GcRunBead, string>,
  physicalLogicalTargets: ReadonlySet<string>,
): Map<string, string> {
  const candidates = new Map<string, Set<string>>();

  for (const bead of beads) {
    const constructKind = constructKindFor(bead, rootBeadId);
    if (isHiddenConstruct(constructKind)) continue;
    const resolved = semanticIds.get(bead) ?? semanticNodeIdFor(bead, rootBeadId);
    for (const alias of visibleNodeAliases(
      bead,
      rootBeadId,
      resolved,
      physicalLogicalTargets,
    )) {
      const existing = candidates.get(alias) ?? new Set<string>();
      existing.add(resolved);
      candidates.set(alias, existing);
    }
  }

  const aliases = new Map<string, string>();
  for (const [alias, targets] of candidates) {
    if (targets.size === 1) {
      const [target] = [...targets];
      if (target) aliases.set(alias, target);
    }
  }
  return aliases;
}

function visibleNodeAliases(
  bead: GcRunBead,
  rootBeadId: string,
  resolved: string,
  physicalLogicalTargets: ReadonlySet<string>,
): string[] {
  return [
    resolved,
    semanticNodeIdFor(bead, rootBeadId),
    groupingBaseSemanticId(bead, rootBeadId, physicalLogicalTargets),
    stableSemanticIdentity(bead, rootBeadId),
    meta(bead, 'gc.step_id'),
    fullStepRefIdentity(normalizedStepRef(bead)),
    nonEmpty(bead.id),
  ]
    .filter((value): value is string => value !== undefined)
    .map((value) => externalizeId(value));
}

function referencedPhysicalLogicalTargets(
  beads: readonly GcRunBead[],
): Set<string> {
  const beadIds = new Set(
    beads
      .map((bead) => nonEmpty(bead.id))
      .filter((value): value is string => value !== undefined),
  );
  const targets = new Set<string>();
  for (const bead of beads) {
    const logical = meta(bead, 'gc.logical_bead_id') ?? nonEmpty(bead.logical_bead_id);
    if (logical && beadIds.has(logical)) targets.add(logical);
  }
  return targets;
}

function resolveBadgeTarget(
  bead: GcRunBead,
  rootBeadId: string,
  aliases: Map<string, string>,
  fallback: string | null,
): string | null {
  if (constructKindFor(bead, rootBeadId) === 'run-finalize') return rootBeadId;
  for (const candidate of hiddenBadgeTargetCandidates(bead, fallback)) {
    const target = aliases.get(candidate);
    if (target) return target;
  }
  return fallback;
}

function hiddenBadgeTargetCandidates(
  bead: GcRunBead,
  fallback: string | null,
): string[] {
  return [
    meta(bead, 'gc.control_for'),
    hiddenBadgeFullTargetFor(bead),
    fallback ?? undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .flatMap((value) => {
      const stripped = stripControlSuffix(value);
      return [value, stripped, externalizeId(stripped)];
    })
    .map((value) => externalizeId(value));
}

function stableSemanticIdentity(
  bead: GcRunBead,
  rootBeadId: string,
): string | undefined {
  const beadId = nonEmpty(bead.id);
  if (beadId && beadId === rootBeadId) return rootBeadId;
  const explicit = meta(bead, 'gc.logical_bead_id') ?? nonEmpty(bead.logical_bead_id);
  if (explicit) return externalizeId(explicit);
  const stepId = meta(bead, 'gc.step_id');
  if (stepId) return externalizeId(stepId);
  return fullStepRefIdentity(normalizedStepRef(bead));
}

function hiddenBadgeFullTargetFor(bead: GcRunBead): string | undefined {
  const controlFor = meta(bead, 'gc.control_for');
  if (controlFor) return externalizeId(stripControlSuffix(controlFor));
  return fullStepRefIdentity(stripControlSuffix(normalizedStepRef(bead) ?? ''));
}

function fullStepRefIdentity(ref: string | null | undefined): string | undefined {
  const clean = nonEmpty(ref);
  if (!clean) return undefined;
  const stripped = stripControlSuffix(clean);
  const parts = stripped.split('.').filter(Boolean);
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return externalizeId(parts[0] ?? stripped);
  return externalizeId(parts.slice(1).join('.'));
}

function stripControlSuffix(ref: string): string {
  return ref.replace(/-scope-check$/, '').replace(/\.scope-check$/, '');
}
