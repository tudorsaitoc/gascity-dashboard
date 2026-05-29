import type { GcWorkflowBead, WorkflowFormulaSource } from 'gas-city-dashboard-shared';
import { meta } from './bead-fields.js';

/**
 * Resolved workflow formula name plus the provenance of that name.
 *
 * `source` carries which resolution path produced `name`:
 *  - `'metadata'` — the workflow root carried an explicit `gc.formula` key.
 *  - `'title_fallback'` — gc.formula was absent and the resolver derived
 *    the name from the bead title under the graph.v2 + `gc.run_target`
 *    gate. The dashboard surfaces this provenance to the operator in a
 *    warn tone instead of letting it pass as canonical metadata. See
 *    gascity-dashboard-e7hj for the precedent.
 */
export interface ResolvedWorkflowFormulaName {
  name: string;
  source: WorkflowFormulaSource;
}

/**
 * Resolve a workflow root bead to its formula name and the provenance of
 * that name.
 *
 * gascity-dashboard-sadp: the live supervisor does NOT set `gc.formula` on
 * graph.v2 workflow roots — the formula name lives in the bead title by
 * convention (verified against live ds-research data: title equals the
 * registered formula name for every observed graph.v2 root, including
 * `mol-focus-review`, `mol-dashboard-graphv2-smoke`). Without this
 * fallback, both the formula-detail fetch in routes/workflows.ts and the
 * presentation-enrichment in formula-run.ts would treat graph.v2 lanes as
 * missing a formula, collapsing every graph.v2 run-detail page to an
 * empty `formula_detail_unavailable` state.
 *
 * The gate on `gc.run_target` is what keeps the fallback honest: only
 * fully-instantiated runnable roots set both `gc.formula_contract` and
 * `gc.run_target`. Operator-edited descriptive titles on closed roots
 * without a target won't be mis-surfaced as formula names. (Closed
 * graph.v2 roots that DO retain `gc.run_target` are not covered by this
 * guard — see gascity-dashboard-sadp follow-up for tighter heuristics if
 * that case is observed in practice.)
 *
 * Returns `{name, source}`, or `null` if neither the explicit key nor the
 * gated title fallback yields one. Callers may layer additional fallbacks
 * (e.g. `formulaDetail?.name` for the rare case where the detail fetch
 * succeeds despite missing root metadata) — those fallback paths attach
 * their own `source` value.
 *
 * Returning a single object (rather than `name()` + `source()`) keeps the
 * call atomic so a caller cannot accidentally surface a name from one
 * resolution path with the source label of another.
 */
export function resolveWorkflowFormulaName(
  root: GcWorkflowBead | undefined,
): ResolvedWorkflowFormulaName | null {
  if (!root) return null;
  const explicit = meta(root, 'gc.formula');
  if (explicit !== undefined) return { name: explicit, source: 'metadata' };
  if (
    meta(root, 'gc.formula_contract') === 'graph.v2' &&
    meta(root, 'gc.run_target') !== undefined
  ) {
    const title = root.title.trim();
    if (title.length > 0) return { name: title, source: 'title_fallback' };
  }
  return null;
}
