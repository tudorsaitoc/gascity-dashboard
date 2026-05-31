import type { LinkNodeType } from 'gas-city-dashboard-shared';
import { makeNodeKey } from 'gas-city-dashboard-shared';
import { BEAD_ID_RE } from '../lib/beadId.js';

// Ref parsing, validation, and URL sanitisation for the linked view
// (gascity-dashboard-j4x). The :ref path segment is a trust boundary:
// it arrives from the browser, and bead metadata (which becomes node
// urls) arrives from the supervisor. Both are validated here, in one
// place, so the allow-list can't be forgotten on a later surface (the
// premortem's "4th copy" failure mode).

export type ParsedRef =
  | { ok: true; type: ParsedRefType; value: string }
  | { ok: false; error: string };

export type ParsedRefType =
  | 'bead'
  | 'github_pr'
  | 'github_issue'
  | 'session'
  | 'formula_run';

const PR_RE = /^pr\/(\d{1,9})$/;
const ISSUE_RE = /^issue\/(\d{1,9})$/;

/**
 * Resolve a `:ref` path segment to its kind + canonical value. Accepts:
 *   - `pr/<n>`        → github_pr
 *   - `issue/<n>`     → github_issue
 *   - a bead id       → bead (also the focus for formula-run / session
 *                       refs, which are bead-id-shaped and resolved by the
 *                       index against the bead set)
 *
 * A malformed ref returns `{ ok: false }` so the route can answer 400
 * rather than scanning for nothing.
 */
export function parseRef(raw: string): ParsedRef {
  const value = raw.trim();
  if (value.length === 0) return { ok: false, error: 'empty ref' };

  const prMatch = PR_RE.exec(value);
  if (prMatch?.[1]) return { ok: true, type: 'github_pr', value: prMatch[1] };

  const issueMatch = ISSUE_RE.exec(value);
  if (issueMatch?.[1]) {
    return { ok: true, type: 'github_issue', value: issueMatch[1] };
  }

  // Everything else must be a bead-id-shaped token (which also covers
  // session ids and run ids — they share the supervisor's id
  // alphabet and are resolved against the bead set by the index).
  if (BEAD_ID_RE.test(value)) return { ok: true, type: 'bead', value };

  return { ok: false, error: 'unrecognised ref' };
}

/**
 * R4 — every rendered cross-entity URL passes an `^https?://` allow-list.
 * Bead metadata is a trust boundary; React does not strip `javascript:`
 * from hrefs (cf. runs.ts externalUrl, gascity-dashboard-4x3).
 * Returns the URL unchanged when it is http(s), else null.
 */
export function sanitiseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

/**
 * Namespaced node key. `scope` already encodes kind+ref
 * (`<scope_kind>:<scope_ref>`, e.g. `city:ds-research` or `rig:rig-a`;
 * see relation-index.ts `beadScope`), so distinct-rig beads — and beads
 * of differing scope KIND that share a bare ref — of the same bare id
 * never collide (RK1 / OQ#1).
 */
export function nodeKey(
  type: LinkNodeType,
  ref: string,
  scope: string,
): string {
  return makeNodeKey(type, ref, scope);
}
