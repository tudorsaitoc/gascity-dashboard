// "Work in flight" derivation — the operator's at-a-glance view of what is
// actually being worked on right now.
//
// The agent roster (configured agent slots) is the WRONG signal for this:
// the supervisor reports nearly every worker slot as state=stopped with no
// active bead, because the live work happens in dynamically-spawned worker
// SESSIONS, not the configured slots. Driving off the roster makes "working"
// read as 0 even when the city is busy.
//
// The RIGHT signal is the in-progress beads — the actual units of work. Each
// in-progress bead carries an `assignee` that embeds the live session id:
//
//   bead gc-5rarj               assignee polecat-gc-335825          → gc-335825
//   bead scix_experiments-4if7h assignee scix-worker-gc-335812      → gc-335812
//   bead EnterpriseBench-mda    assignee enterprisebench-worker-gc-335808 → gc-335808
//
// Pattern: `<worker-role>-<session-id>` where the session id is the trailing
// `gc-…` (or other 2/4-letter-prefixed) handle. Extract the session id, join
// it to the live sessions list, and the result is one row per unit of work:
// who (role), where (rig), what (bead id + title), and the live session state.
//
// Pure over the shared wire types (GcBead + GcSession) — no IO, no React, no
// DOM. The frontend layers display-label cleaning on top via projectOf helpers.

// The derivation reads only a handful of fields. Parametrize over these
// structural minimums (rather than the full GcBead/GcSession) so both the
// shared wire types AND the generated supervisor client types — which differ
// in optionality under exactOptionalPropertyTypes — can be passed without a
// cast at the call sites.
export interface WorkInFlightBead {
  id: string;
  title: string;
  status: string;
  assignee?: string;
  created_at: string;
  updated_at?: string;
}

export interface WorkInFlightSession {
  id: string;
  state: string;
  rig?: string;
  last_active?: string;
}

/**
 * The trailing supervisor session-handle embedded in an assignee. Anchored to
 * the END of the string and preceded by a boundary (`-`, `_`, `/`, or start),
 * so `polecat-gc-335825` yields `gc-335825` and the role prefix is whatever
 * comes before.
 *
 * The handle prefix mirrors SESSION_ID_RE (`gc`/`td`/`th` literal or any
 * 4-letter city code). The id BODY is deliberately tightened to `[a-z0-9]`
 * (no internal hyphen) so the match binds to the MINIMAL trailing handle:
 * without that, a role like `scix-worker` (whose `scix` is itself a 4-letter
 * token) would let the greedy body swallow `scix-worker-gc-335812` whole. Live
 * session ids are hyphen-free after the prefix dash (`gc-335825`, `td-9abc`),
 * so this loses nothing real.
 */
const ASSIGNEE_SESSION_ID_RX =
  /[-_/]((?:gc|td|th|[a-z]{4})-[a-z0-9]{1,32})$/;

// A bare session handle (the assignee IS a session id, no role prefix). Same
// alphabet as ASSIGNEE_SESSION_ID_RX but whole-string. NOT SESSION_ID_RE: that
// validator permits internal hyphens in the body, which would let a composite
// like `scix-worker-gc-335812` masquerade as one bare handle.
//
// The id body MUST contain at least one digit. Live session ids always carry a
// numeric handle (`gc-335825`, `td-9abc`); a plain 4-letter-prefixed *role* like
// `scix-worker` would otherwise match (`scix` prefix + `worker` body) and be
// misparsed as a bare session id. Requiring a digit keeps roles out.
const BARE_SESSION_ID_RX =
  /^(?:gc|td|th|[a-z]{4})-[a-z0-9]*[0-9][a-z0-9]*$/;

export interface ParsedAssignee {
  /** The extracted live session id (e.g. `gc-335825`), or undefined when the
   *  assignee carries no recognizable session handle. */
  sessionId?: string;
  /** The worker-role prefix with the session-id suffix stripped
   *  (e.g. `polecat`, `scix-worker`, `enterprisebench-worker`). Falls back to
   *  the whole assignee when no session suffix is present. */
  role: string;
}

/**
 * Split a bead assignee into its worker role and embedded session id.
 *
 * `polecat-gc-335825` → `{ role: 'polecat', sessionId: 'gc-335825' }`.
 * An assignee with no session handle (e.g. a bare alias) yields the whole
 * string as the role and no sessionId — the caller degrades gracefully.
 */
export function parseAssignee(assignee: string): ParsedAssignee {
  const trimmed = assignee.trim();
  // Bare handle: the assignee IS a session id with no role prefix. Name the row
  // with the id itself so it still reads.
  if (BARE_SESSION_ID_RX.test(trimmed)) {
    return { role: trimmed, sessionId: trimmed };
  }
  const match = ASSIGNEE_SESSION_ID_RX.exec(trimmed);
  const sessionId = match?.[1];
  if (match === null || sessionId === undefined) {
    return { role: trimmed };
  }
  // Strip the matched `<sep>gc-…` tail to recover the role. The match starts at
  // the separator boundary, so slice up to match.index.
  return { role: trimmed.slice(0, match.index), sessionId };
}

/**
 * One unit of work in flight: an in-progress bead joined to the live worker
 * session it is assigned to. `session` is undefined when the embedded session
 * id does not resolve to a live session (completed/closed/never-spawned) — the
 * row is still emitted so the bead + assignee remain visible (graceful
 * degradation; never silently drop work).
 */
export interface WorkInFlightRow<
  B extends WorkInFlightBead = WorkInFlightBead,
  S extends WorkInFlightSession = WorkInFlightSession,
> {
  bead: B;
  /** Raw assignee string, or undefined when the bead carries none. */
  assignee?: string;
  /** Worker role parsed from the assignee (e.g. `polecat`). Undefined when the
   *  bead has no assignee at all. */
  role?: string;
  /** Live session joined by the embedded id, or undefined when unresolved. */
  session?: S;
}

/**
 * The bead status that means "actively being worked on". A single literal so
 * the work-in-flight filter and the status badge stay in lockstep.
 */
export const IN_PROGRESS_STATUS = 'in_progress';

function recencyKey(row: WorkInFlightRow): number {
  // Read through the structural minimum (WorkInFlightBead/Session).
  // Prefer the live session's last activity (the freshest signal of work), then
  // fall back to the bead's update/create time. Unparseable timestamps sort
  // oldest so rows with real activity float to the top.
  const candidate =
    row.session?.last_active ?? row.bead.updated_at ?? row.bead.created_at;
  const ms = candidate ? Date.parse(candidate) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Derive the work-in-flight rows from the raw beads + sessions lists.
 *
 * Steps (mechanical, no semantic judgment):
 *  1. Keep only in-progress beads.
 *  2. Parse each bead's assignee into role + embedded session id.
 *  3. Join the session id to the live sessions list by `session.id`.
 *  4. Sort newest-/most-recently-active first.
 *
 * Beads whose embedded session id does not resolve are retained (session
 * undefined) so nothing in flight is dropped.
 */
export function deriveWorkInFlight<
  B extends WorkInFlightBead,
  S extends WorkInFlightSession,
>(
  beads: readonly B[],
  sessions: readonly S[],
): WorkInFlightRow<B, S>[] {
  const sessionsById = new Map<string, S>();
  for (const session of sessions) sessionsById.set(session.id, session);

  const rows: WorkInFlightRow<B, S>[] = [];
  for (const bead of beads) {
    if (bead.status !== IN_PROGRESS_STATUS) continue;
    const assignee = bead.assignee?.trim();
    if (assignee === undefined || assignee.length === 0) {
      rows.push({ bead });
      continue;
    }
    const { role, sessionId } = parseAssignee(assignee);
    const session = sessionId ? sessionsById.get(sessionId) : undefined;
    rows.push({ bead, assignee, role, ...(session ? { session } : {}) });
  }

  return rows.sort((a, b) => recencyKey(b) - recencyKey(a));
}
