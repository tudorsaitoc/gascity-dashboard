import type {
  BeadStatus,
  ConvoyView,
  DashboardBead,
  RunFormulaSource,
} from 'gas-city-dashboard-shared';
import {
  BEAD_ID_RE,
  isGraphV2RunRoot,
  isTerminalRunRootStatus,
  projectConvoyView,
  resolveRunFormulaIdentity,
} from 'gas-city-dashboard-shared';
import { LOG_COMPONENT, logWarn } from '../lib/logging';
import { fetchBeadSubtreeIds, fetchSupervisorBead, listSupervisorBeads } from './beadReads';
import { SupervisorApiError } from './client';
import { normalizeBead, normalizeBeads } from './normalizeBead';

// Loader for the /convoy/:rootBead route (gascity-dashboard-caag, Shape A).
//
// It COMPOSES the generated supervisor client — the root bead plus a bounded
// city bead read — and derives the convoy's step graph client-side from the
// `parent` chain, exactly as the Beads board inverts `needs`.
//
// Why the derived path, not the supervisor's convoy/{id} or beads/graph/{root}
// endpoints (both DO exist on the generated client — gascity-dashboard-y6v3):
// neither yields usable data for the graph.v2 workflow roots this route is
// reached with (linked only from a run's RootMeta, i.e. a run root bead).
// Verified against a live city:
//   * convoy/{id} is keyed by a convoy ENTITY id, not a root bead id — calling
//     it with a run root returns the workflow-snapshot case, which carries no
//     `progress` field (and the generated `ConvoyGetResponse` does not model
//     that case); a plain bead 404s "is not a convoy". Convoy progress is only
//     populated for non-workflow convoy entities the /convoy/:rootBead route
//     never addresses.
//   * beads/graph/{root} collapses graph.v2 snapshots to the root bead alone
//     (the same upstream hole tracked by gascity-dashboard-jl3c), so it returns
//     no step children the parent-chain scan does not — and it is slow. So it is
//     not the projection source; it serves only as the authoritative subtree
//     walk that confirms completeness on the truncated-page path (jy3d, below).
// So there is no supervisor progress count to prefer: `projectConvoyView`
// derives progress from the materialized children, and a graph.v2 root with no
// exposed children collapses to the honest "steps not exposed" state. The
// authoritative graph.v2 step graph lives in the workflow snapshot
// (WorkflowSnapshotResponse) — wiring it here is the jl3c redesign, out of
// scope for this loader. The route composes only allowlisted reads — `beads`,
// `bead/{id}`, and the `beads/graph/{rootID}` completeness walk — so it works
// under DASHBOARD_READONLY=1 as-is.
//
// Truncation is honest AND subtree-scoped: a busy city's closed beads can
// exceed one bounded page, but a truncated city page only matters when it could
// be hiding a member of THIS convoy's subtree. So when the page read is
// incomplete (the supervisor flags it, returns a `next_cursor`, or its total
// outruns the page) the loader confirms the subtree against the authoritative
// graph walk before warning — see `deriveConvoyPartial` (gascity-dashboard-jy3d).

// Convoy step beads are bookkeeping-typed and frequently closed, so the read
// must include both — unlike the board's default open/engineering view.
const CONVOY_FETCH_LIMIT = 1_000;

export interface ConvoyLoad {
  view: ConvoyView;
  partial: boolean;
}

/** One row of the /convoy index: an active convoy keyed by its root bead. */
export interface ConvoyRootSummary {
  rootBeadId: string;
  title: string;
  status: BeadStatus;
  /** Formula driving the convoy, when the root carries (or implies) one. */
  formulaName: string | null;
  /** Provenance of `formulaName` so a title-inferred name can be surfaced honestly. */
  formulaNameProvenance: RunFormulaSource | null;
}

export interface ConvoyRootsLoad {
  roots: readonly ConvoyRootSummary[];
  /** The bounded city scan was truncated, so a convoy root may be hidden. */
  partial: boolean;
}

/**
 * List the active convoy roots for the /convoy index (gascity-dashboard-0chv3).
 *
 * It reuses the SAME bounded city bead scan the detail loader runs, then keeps
 * only fully-instantiated graph.v2 run roots (`isGraphV2RunRoot`) that are still
 * in flight (`!isTerminalRunRootStatus`) — so a completed convoy drops off the
 * front door on its own. `partial` is the raw page-truncation signal: unlike the
 * detail page (which narrows truncation to a single convoy's subtree), the index
 * is honestly partial whenever the scan that could surface a NEW root was
 * truncated. Newest roots sort first.
 */
export async function loadActiveConvoyRoots(): Promise<ConvoyRootsLoad> {
  const list = await listSupervisorBeads({
    includeClosed: true,
    includeBookkeeping: true,
    limit: CONVOY_FETCH_LIMIT,
  });
  const roots = normalizeBeads(list.items)
    .filter((bead) => isGraphV2RunRoot(bead) && !isTerminalRunRootStatus(bead.status))
    .sort(compareRootsNewestFirst)
    .map(toRootSummary);
  return { roots, partial: list.partial };
}

function toRootSummary(root: DashboardBead): ConvoyRootSummary {
  const identity = resolveRunFormulaIdentity('route', { root });
  return {
    rootBeadId: root.id,
    title: root.title,
    status: root.status,
    formulaName: identity.name,
    // `formula_detail` is unreachable in route mode (no detail fetch here), so
    // narrow the source to RunFormulaSource | null without a cast.
    formulaNameProvenance: identity.source === 'formula_detail' ? null : identity.source,
  };
}

/** Newest convoy first; id breaks ties so the order is stable across reads. */
function compareRootsNewestFirst(a: DashboardBead, b: DashboardBead): number {
  const byCreated = b.created_at.localeCompare(a.created_at);
  return byCreated !== 0 ? byCreated : a.id.localeCompare(b.id);
}

export async function loadConvoyView(rootBeadId: string): Promise<ConvoyLoad> {
  // The root id is the untrusted `/convoy/:rootBead` route param. Validate it at
  // this loader boundary — the single chokepoint before either supervisor read
  // (the root `bead/{id}` and the `beads/graph/{rootID}` completeness walk) — so
  // a malformed id never reaches a supervisor path param. A garbage id cannot
  // name a real bead, so surface it as the route's honest not-found state rather
  // than a generic failure (the proxy's traversal gate already blocks the
  // high-risk forms; this is defense-in-depth at the data edge).
  if (!BEAD_ID_RE.test(rootBeadId)) {
    throw new SupervisorApiError(404, `invalid bead id: ${rootBeadId}`, undefined);
  }
  const root = normalizeBead(await fetchSupervisorBead(rootBeadId));
  const list = await listSupervisorBeads({
    includeClosed: true,
    includeBookkeeping: true,
    limit: CONVOY_FETCH_LIMIT,
  });
  const beads = normalizeBeads(list.items);
  const children = descendantsOf(root.id, beads);
  const view = projectConvoyView(root, children, null);
  return {
    view,
    partial: await deriveConvoyPartial(view, children, list.partial),
  };
}

/**
 * Whether the convoy view is built from an incomplete subtree — the precise
 * signal behind the route's "Partial convoy" notice (gascity-dashboard-jy3d).
 *
 * A complete city page proves the subtree is whole, so it is never partial. A
 * truncated city page only matters when it could be hiding a member of THIS
 * convoy's subtree, so the broad `list.partial` is narrowed in two steps:
 *
 *  - A graph.v2 run root collapses to `graph_v2_root_only`, and a truncated page
 *    cannot be hiding its steps — but the empty parent-scan is NOT itself the
 *    proof of that (an empty scan looks the same whether the steps don't exist
 *    or were truncated away). The proof is upstream and was verified live
 *    (against the live supervisor, 2026-06-16): the supervisor does not
 *    materialize graph.v2 step beads as city beads at all (the
 *    gascity-dashboard-jl3c hole) — they never appear as `parent`-linked rows in
 *    the city page (the `parent` field exists on the wire and `descendantsOf`
 *    uses it, but no graph.v2 step is ever present to carry it), and
 *    `beads/graph/{root}` collapses graph.v2 snapshots to the root alone —
 *    neither the list nor the authoritative walk can surface a graph.v2 step, so
 *    there is no descendant a truncated page could drop. The steps live only in
 *    the workflow snapshot (jl3c, out of scope here). Were that to change
 *    upstream (parent-linked graph.v2 steps materialized in the city page), this
 *    short-circuit would no longer hold and the walk below would have to decide —
 *    but the walk would also need beads/graph to stop collapsing, so revisit
 *    jl3c together.
 *  - Otherwise (materialized steps, or a leaf a truncated page might be hiding
 *    children behind) the authoritative graph walk reports the true descendant
 *    set; the convoy is partial only when that set holds an id the bounded page
 *    did not capture.
 *
 * The graph walk runs only on the truncated-page path, so the slower scoped read
 * is paid only in the large-city case it disambiguates. If it fails the loader
 * stays conservative (over-warn, never hide missing steps) and logs the
 * degradation rather than swallowing it.
 */
async function deriveConvoyPartial(
  view: ConvoyView,
  children: readonly DashboardBead[],
  cityPagePartial: boolean,
): Promise<boolean> {
  if (!cityPagePartial) return false;
  if (view.exposure.kind === 'collapsed' && view.exposure.reason === 'graph_v2_root_only') {
    return false;
  }
  try {
    const subtreeIds = await fetchBeadSubtreeIds(view.rootBeadId);
    const captured = new Set(children.map((child) => child.id));
    return subtreeIds.some((id) => !captured.has(id));
  } catch (err) {
    logWarn(
      LOG_COMPONENT.convoy,
      `subtree completeness check failed for ${view.rootBeadId}; staying conservative: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return true;
  }
}

/**
 * Collect the transitive `parent`-chain descendants of `rootId` from the flat
 * bead list, excluding the root itself. Cycles cannot inflate the result — a
 * bead already visited is never re-queued.
 */
function descendantsOf(rootId: string, beads: readonly DashboardBead[]): DashboardBead[] {
  const childrenByParent = new Map<string, DashboardBead[]>();
  for (const bead of beads) {
    if (bead.parent === undefined || bead.parent === bead.id) continue;
    const siblings = childrenByParent.get(bead.parent);
    if (siblings === undefined) childrenByParent.set(bead.parent, [bead]);
    else siblings.push(bead);
  }

  const collected: DashboardBead[] = [];
  const seen = new Set<string>([rootId]);
  // BFS over a growing frontier. `for...of` yields each id as a plain `string`
  // (no `shift()`/index `string | undefined` to assert away) and the Array
  // iterator observes ids pushed mid-loop, so newly-found descendants are
  // visited in turn. `seen` makes the push idempotent, so a cycle terminates.
  const frontier: string[] = [rootId];
  for (const parentId of frontier) {
    for (const child of childrenByParent.get(parentId) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      collected.push(child);
      frontier.push(child.id);
    }
  }
  return collected;
}
