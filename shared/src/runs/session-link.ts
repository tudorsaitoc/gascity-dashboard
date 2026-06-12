import type { RunSnapshotBead } from '../run-snapshot.js';
import type { DashboardSession } from '../dashboard-sessions.js';
import type { RunNodeStatus, RunSessionLink } from '../run-detail.js';
import { SESSION_ID_RE } from '../session-id.js';
import { meta, nonEmpty } from './bead-fields.js';

export interface RunSessionIndex {
  byId: Map<string, DashboardSession>;
  byName: Map<string, DashboardSession>;
  byTemplate: Map<string, DashboardSession[]>;
}

export interface RunSessionLinkContext {
  sessionIndex?: RunSessionIndex;
  scopeRef?: string;
}

export function buildRunSessionIndex(sessions: readonly DashboardSession[]): RunSessionIndex {
  const byId = new Map<string, DashboardSession>();
  const byName = new Map<string, DashboardSession>();
  const byTemplate = new Map<string, DashboardSession[]>();

  for (const session of sessions) {
    remember(byId, session.id, session);
    remember(byName, session.alias, session);
    remember(byName, session.title, session);
    remember(byName, session.session_name, session);
    const template = nonEmpty(session.template);
    if (template) byTemplate.set(template, [...(byTemplate.get(template) ?? []), session]);
  }

  return { byId, byName, byTemplate };
}

export function runSessionLinkFor(
  bead: RunSnapshotBead,
  status: RunNodeStatus,
  context: RunSessionLinkContext = {},
): RunSessionLink | undefined {
  if (status === 'pending' || status === 'ready') return undefined;
  const assignee = nonEmpty(bead.assignee);
  // The bead's recorded session id can be a pool-qualified session NAME
  // (e.g. a polecat run records `polecat-gc-333573`, whose real supervisor
  // session id is `gc-333573`). Normalize every candidate through
  // supervisorSessionIdFrom so the link carries the id the session routes
  // expect — otherwise a completed session (absent from the live index, so
  // unresolvable by name) leaks its name into the id slot and the Session
  // tab rejects it as "invalid session id".
  const rawSessionId =
    meta(bead, 'session_id') ??
    meta(bead, 'gc.session_id') ??
    meta(bead, 'gc.sessionId') ??
    assignee;
  const sessionId = supervisorSessionIdFrom(rawSessionId) ?? rawSessionId;
  const sessionName =
    meta(bead, 'session_name') ??
    meta(bead, 'gc.session_name') ??
    meta(bead, 'gc.sessionName') ??
    assignee ??
    sessionId;
  if (!sessionId && !sessionName) return undefined;
  const rawLink: RunSessionLink = {
    sessionId: sessionId ?? sessionName ?? '',
    sessionName: sessionName ?? sessionId ?? '',
    assignee: assignee ?? sessionName ?? sessionId ?? '',
  };
  const link = resolveRunSessionLink(rawLink, context.sessionIndex);
  // Final gate: link.sessionId is fed straight to the supervisor session
  // routes, which reject anything outside SESSION_ID_RE as "invalid session
  // id". When the index could not resolve the run to a real session (a
  // completed pool/rig-store run has dropped out of the live index) and the
  // recorded handle carries no extractable supervisor id, drop the link so the
  // Session tab degrades to a clean "session not available" state instead of
  // leaking an unvalidated handle into the route.
  if (!SESSION_ID_RE.test(link.sessionId)) return undefined;
  return link;
}

// The recorded handle is frequently the pool-qualified session NAME the
// supervisor built as `{sanitized template base}-{session bead id}` (gascity
// cmd/gc/pool_session_name.go PoolSessionName) — e.g.
// `gc__implementation-worker-mc-wisp-08fqjv` for the supervisor session id
// `mc-wisp-08fqjv`. The session bead id is a bd issue id: a short lowercase
// store prefix (2-4 letters, per-deployment — `mc`, `gc`, `fddc`, ...), an
// optional `wisp-`/`mol-` tier marker, and a numeric or base36-hash suffix
// (beads internal/utils/issue_id.go). Anchor on that full trailing shape: the
// role/template part before it is arbitrary and can itself contain 2-4 letter
// hyphenated words (`design-test-risk-reviewer`), so any looser "short token
// + tail" parse latches onto the role and mangles the id.
const TRAILING_SESSION_BEAD_ID_RE = /(?:^|[-_/])([a-z]{2,4}-(?:(?:wisp|mol)-)?([a-z0-9]{1,32}))$/;

function supervisorSessionIdFrom(value: string | undefined): string | undefined {
  const clean = nonEmpty(value);
  if (!clean) return undefined;
  if (SESSION_ID_RE.test(clean)) return clean;
  const match = clean.match(TRAILING_SESSION_BEAD_ID_RE);
  const candidate = match?.[1];
  const suffix = match?.[2];
  if (!candidate || !suffix || !isBeadIdSuffix(suffix)) return undefined;
  if (!SESSION_ID_RE.test(candidate)) return undefined;
  return candidate;
}

// Mirrors bd's suffix heuristic (beads internal/utils/issue_id.go isNumeric /
// isLikelyHash): a bead-id suffix is all digits, or a 3-8 char lowercase
// base36 hash. 4-8 char hashes must carry a digit so English words in role
// names ("lead", "worker") never read as session ids; 3-char suffixes get the
// same free pass bd gives them.
function isBeadIdSuffix(suffix: string): boolean {
  if (/^[0-9]+$/.test(suffix)) return true;
  if (!/^[a-z0-9]{3,8}$/.test(suffix)) return false;
  return suffix.length === 3 || /[0-9]/.test(suffix);
}

function resolveRunSessionLink(
  rawLink: RunSessionLink,
  sessionIndex: RunSessionIndex | undefined,
): RunSessionLink {
  if (!sessionIndex) return rawLink;
  const session = resolveRunSessionSummary(rawLink, sessionIndex);
  if (!session) return rawLink;
  return linkForSession(session, rawLink);
}

function resolveRunSessionSummary(
  link: RunSessionLink,
  sessionIndex: RunSessionIndex,
): DashboardSession | null {
  for (const candidate of [link.sessionId, link.sessionName, link.assignee]) {
    const key = nonEmpty(candidate);
    if (!key) continue;
    const exact =
      sessionIndex.byId.get(key) ??
      sessionIndex.byName.get(key) ??
      uniquePreferredSession(sessionIndex.byTemplate.get(key) ?? []);
    if (exact) return exact;
  }
  return null;
}

function linkForSession(session: DashboardSession, rawLink: RunSessionLink): RunSessionLink {
  return {
    sessionId: session.id,
    sessionName:
      nonEmpty(session.alias) ??
      nonEmpty(session.title) ??
      nonEmpty(session.session_name) ??
      nonEmpty(session.template) ??
      rawLink.sessionName,
    assignee:
      rawLink.assignee ||
      nonEmpty(session.template) ||
      nonEmpty(session.alias) ||
      nonEmpty(session.title) ||
      nonEmpty(session.session_name) ||
      session.id,
  };
}

function uniquePreferredSession(sessions: readonly DashboardSession[]): DashboardSession | null {
  if (sessions.length === 0) return null;
  const active = sessions.filter(
    (session) => session.state === 'active' || session.running === true,
  );
  if (active.length === 1) return active[0] ?? null;
  if (sessions.length === 1) return sessions[0] ?? null;
  return null;
}

function remember(
  store: Map<string, DashboardSession>,
  key: string | undefined,
  session: DashboardSession,
): void {
  const clean = nonEmpty(key);
  if (!clean || store.has(clean)) return;
  store.set(clean, session);
}
