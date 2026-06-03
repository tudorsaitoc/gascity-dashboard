// Sender-role classification for operator-facing mail — the single owner of the
// "which agent kind is this, and which mail actually needs the human" logic.
//
// This lived in tui/src/derive.ts first (the TUI ledger), but the dashboard
// backend's operator-mail alert derivation (gascity-dashboard-mpfx, R4) needs
// the EXACT same sender-role filter. The backend cannot import from the `tui`
// workspace, so the logic lives here in `shared` (which both import) and a
// drift between the two surfaces becomes a compile error, not a silent
// divergence. The TUI re-exports these from derive.ts for back-compat.
//
// Pure over the shared wire types (GcSession + a minimal OperatorMailItem) — no IO, no React.

import type { GcSession } from './gc-client-types.js';

/**
 * The mail fields the operator-mail sender-role filter reads — read state,
 * sender, and timestamp. Kept as a minimal structural shape rather than a
 * specific wire DTO so the filter stays portable across mail sources (the
 * backend snapshot alert path and the TUI ledger each pass their own wire
 * mail items, which are structurally compatible). The direct-supervisor
 * migration removed the shared GcMailItem DTO; this is the only mail surface
 * this module needs.
 */
export interface OperatorMailItem {
  readonly from: string;
  readonly read: boolean;
  readonly created_at: string;
}

/**
 * Agent kind, derived from the wire data (the supervisor does not label kinds
 * directly — see classification rules in {@link agentKind}):
 * - `pool`: a multi-session worker (a "polecat"); the `pool` field is set, or
 *   the template names the polecat pool.
 * - `role`: a named, single-purpose agent (project-lead, reviewer, deacon, …).
 * - `orch`: city/orchestration layer (mayor, control-dispatcher) that directs
 *   the rest; rig-less, or a control-dispatcher.
 */
export type AgentKind = 'pool' | 'role' | 'orch';

export const AGENT_KINDS: readonly AgentKind[] = ['pool', 'role', 'orch'];

/** Label for the city-level (rig-less) agents: mayor, city control-dispatcher. */
export const ORCHESTRATION = 'orchestration';

const CONTROL_DISPATCHER = 'control-dispatcher';

/** The operator's canonical mail triager. By Gas City convention the mayor
 *  digests the worker firehose and forwards only what needs the human. */
const MAYOR = 'mayor';

export function basename(path: string | null | undefined): string {
  if (!path) return '';
  const trimmed = path.replace(/\/+$/, '');
  const seg = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return seg || trimmed;
}

/**
 * Canonical rig label. The supervisor reports a rig inconsistently — sometimes
 * a filesystem path (`/home/ds/projects/scix_experiments`), sometimes a name
 * (`scix-experiments`), with varying case — which split one project across two
 * groups. Normalise (basename · `_`→`-` · lowercase) so a project is one group.
 */
export function rigLabel(rig: string | null | undefined): string {
  const base = basename(rig);
  if (!base) return ORCHESTRATION;
  return base.replace(/_/g, '-').toLowerCase();
}

/**
 * Classifies an agent's kind from the wire fields. The supervisor does not
 * carry a pool/role label (its `agent_kind` is the unrelated agent/provider
 * axis), so we derive it: orchestration first (a control-dispatcher or a
 * rig-less agent like the mayor directs the rest, regardless of any pool
 * bucket), then a pool worker (a multi-session "polecat", identified by the
 * `pool` field or the polecat template), else a named role agent.
 */
export function agentKind(s: GcSession): AgentKind {
  const template = s.template ?? '';
  const isDispatcher =
    template === CONTROL_DISPATCHER || template.endsWith(`/${CONTROL_DISPATCHER}`) ||
    template.endsWith(`.${CONTROL_DISPATCHER}`);
  if (isDispatcher || rigLabel(s.rig) === ORCHESTRATION) return 'orch';
  if ((s.pool && s.pool.length > 0) || template === 'polecat' || template.endsWith('/polecat')) {
    return 'pool';
  }
  return 'role';
}

/**
 * Mail the operator should actually see: escalations from the orchestration
 * layer (the mayor), not the worker firehose. The wire's `read`/`priority`
 * flags are unusable as a "needs you" signal here — the supervisor never sets
 * priority and the operator never marks mail read (the mayor handles it) — so
 * we filter by SENDER ROLE instead: keep mail from an orchestration-kind agent
 * (resolved against the live session list) or the mayor, fold away pool-worker
 * chatter. Newest first.
 */
export function operatorMail<T extends OperatorMailItem>(
  mail: readonly T[],
  sessions: readonly GcSession[],
): readonly T[] {
  const orchSenders = new Set<string>([MAYOR]);
  for (const s of sessions) {
    if (agentKind(s) === 'orch') orchSenders.add(basename(s.title ?? s.alias ?? s.id) || s.id);
  }
  return mail
    .filter((m) => !m.read && orchSenders.has(basename(m.from)))
    .slice()
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Count of unread mail folded away by {@link operatorMail} — the worker
 *  reports the mayor handles. Surfaced so the filter is never silent. */
export function foldedMailCount(
  mail: readonly OperatorMailItem[],
  shown: readonly OperatorMailItem[],
): number {
  const unread = mail.filter((m) => !m.read).length;
  return Math.max(0, unread - shown.length);
}
