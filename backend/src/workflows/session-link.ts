import type {
  GcSession,
  GcWorkflowBead,
  WorkflowNodeStatus,
  WorkflowSessionLink,
} from 'gas-city-dashboard-shared';
import { SESSION_ID_RE } from '../lib/sessionId.js';
import { meta, nonEmpty } from './bead-fields.js';

export interface WorkflowSessionIndex {
  byId: Map<string, GcSession>;
  byName: Map<string, GcSession>;
  byTemplate: Map<string, GcSession[]>;
}

export interface WorkflowSessionLinkContext {
  sessionIndex?: WorkflowSessionIndex;
  scopeRef?: string;
}

export function buildWorkflowSessionIndex(
  sessions: readonly GcSession[],
): WorkflowSessionIndex {
  const byId = new Map<string, GcSession>();
  const byName = new Map<string, GcSession>();
  const byTemplate = new Map<string, GcSession[]>();

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

export function workflowSessionLinkFor(
  bead: GcWorkflowBead,
  status: WorkflowNodeStatus,
  context: WorkflowSessionLinkContext = {},
): WorkflowSessionLink | null {
  if (status === 'pending' || status === 'ready') return null;
  const assignee = nonEmpty(bead.assignee);
  const sessionId =
    meta(bead, 'session_id') ??
    supervisorSessionIdFrom(assignee) ??
    assignee;
  const sessionName =
    meta(bead, 'session_name') ??
    assignee ??
    sessionId;
  const rawLink =
    sessionId || sessionName
      ? {
          sessionId: sessionId ?? sessionName ?? '',
          sessionName: sessionName ?? sessionId ?? '',
          assignee: assignee ?? sessionName ?? sessionId ?? '',
          rigId: meta(bead, 'rig_id'),
        }
      : null;
  if (!rawLink) return null;
  return resolveWorkflowSessionLink(rawLink, context.sessionIndex);
}

function supervisorSessionIdFrom(value: string | undefined): string | undefined {
  const clean = nonEmpty(value);
  if (!clean) return undefined;
  if (SESSION_ID_RE.test(clean)) return clean;
  const suffix = clean.match(/(?:^|[-_/])((?:gc|td|th|[a-z]{4})-[a-z0-9-]{1,32})$/)?.[1];
  if (!suffix || !SESSION_ID_RE.test(suffix)) return undefined;
  return suffix;
}

function resolveWorkflowSessionLink(
  rawLink: WorkflowSessionLink,
  sessionIndex: WorkflowSessionIndex | undefined,
): WorkflowSessionLink {
  if (!sessionIndex) return rawLink;
  const session = resolveWorkflowSessionSummary(rawLink, sessionIndex);
  if (!session) return rawLink;
  return linkForSession(session, rawLink);
}

function resolveWorkflowSessionSummary(
  link: WorkflowSessionLink,
  sessionIndex: WorkflowSessionIndex,
): GcSession | null {
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

function linkForSession(
  session: GcSession,
  rawLink: WorkflowSessionLink,
): WorkflowSessionLink {
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
    rigId: nonEmpty(session.rig) ?? rawLink.rigId,
  };
}

function uniquePreferredSession(sessions: readonly GcSession[]): GcSession | null {
  if (sessions.length === 0) return null;
  const active = sessions.filter((session) => session.state === 'active' || session.running === true);
  if (active.length === 1) return active[0] ?? null;
  if (sessions.length === 1) return sessions[0] ?? null;
  return null;
}

function remember(
  store: Map<string, GcSession>,
  key: string | undefined,
  session: GcSession,
): void {
  const clean = nonEmpty(key);
  if (!clean || store.has(clean)) return;
  store.set(clean, session);
}
