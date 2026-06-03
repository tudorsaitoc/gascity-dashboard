import type { SlingIntent, SlingKind } from './operator.js';

export const MAINTAINER_SLING_TARGET_RE = /^[a-z][a-z0-9_./-]{1,63}$/i;

const GH_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(issues|pull)\/\d+$/;
const MAX_URL_LEN = 2_048;

export interface MaintainerSlingTargetDefaults {
  readonly slingTarget: string;
  readonly triageTarget?: string;
}

export interface MaintainerSlingRequest {
  readonly kind: SlingKind;
  readonly number: number;
  readonly html_url: string;
  readonly intent: SlingIntent;
  readonly target?: string;
}

export interface PreparedMaintainerSlingRequest {
  readonly kind: SlingKind;
  readonly number: number;
  readonly html_url: string;
  readonly intent: SlingIntent;
  readonly target: string;
  readonly beadText: string;
}

export type PrepareMaintainerSlingRequestResult =
  | { readonly status: 'ok'; readonly request: PreparedMaintainerSlingRequest }
  | { readonly status: 'error'; readonly message: string };

export interface MaintainerSlingRecordRequest {
  readonly kind: SlingKind;
  readonly number: number;
  readonly intent: SlingIntent;
  readonly target: string;
  readonly bead_id: string | null;
  readonly resolved_session_name: string | null;
}

export type DecodeMaintainerSlingRecordResult =
  | { readonly status: 'ok'; readonly record: MaintainerSlingRecordRequest }
  | { readonly status: 'error'; readonly message: string };

export function prepareMaintainerSlingRequest(
  value: unknown,
  defaults: MaintainerSlingTargetDefaults,
): PrepareMaintainerSlingRequestResult {
  if (!isRecord(value)) return invalidPrepared('request body must be an object');
  const body = value;
  if (!isSlingKind(body.kind)) return invalidPrepared('invalid kind (pr|issue)');
  if (!isSlingIntent(body.intent)) return invalidPrepared('invalid intent (review|draft|triage)');
  if (!isValidIssueNumber(body.number)) return invalidPrepared('invalid number');
  if (typeof body.html_url !== 'string' || body.html_url.length > MAX_URL_LEN) {
    return invalidPrepared('invalid html_url');
  }
  const urlMatch = GH_URL_RE.exec(body.html_url);
  if (urlMatch === null) return invalidPrepared('invalid html_url');
  const urlPath = urlMatch[1];
  const expected = body.kind === 'pr' ? 'pull' : 'issues';
  if (urlPath !== expected) return invalidPrepared('kind/html_url mismatch');

  let target =
    body.intent === 'triage' && defaults.triageTarget !== undefined
      ? defaults.triageTarget
      : defaults.slingTarget;
  if (!MAINTAINER_SLING_TARGET_RE.test(target)) {
    return invalidPrepared('invalid target alias');
  }
  if (body.target !== undefined) {
    if (typeof body.target !== 'string' || !MAINTAINER_SLING_TARGET_RE.test(body.target)) {
      return invalidPrepared('invalid target alias');
    }
    target = body.target;
  }

  return {
    status: 'ok',
    request: {
      kind: body.kind,
      number: body.number,
      html_url: body.html_url,
      intent: body.intent,
      target,
      beadText: composeBeadText(body.intent, body.html_url),
    },
  };
}

export function decodeMaintainerSlingRecord(
  value: unknown,
): DecodeMaintainerSlingRecordResult {
  if (!isRecord(value)) return invalidRecord('request body must be an object');
  if (!isSlingKind(value.kind)) return invalidRecord('invalid kind (pr|issue)');
  if (!isSlingIntent(value.intent)) return invalidRecord('invalid intent (review|draft|triage)');
  if (!isValidIssueNumber(value.number)) return invalidRecord('invalid number');
  if (typeof value.target !== 'string' || !MAINTAINER_SLING_TARGET_RE.test(value.target)) {
    return invalidRecord('invalid target alias');
  }
  if (value.bead_id !== null && typeof value.bead_id !== 'string') {
    return invalidRecord('invalid bead_id');
  }
  if (value.resolved_session_name !== null && typeof value.resolved_session_name !== 'string') {
    return invalidRecord('invalid resolved_session_name');
  }
  return {
    status: 'ok',
    record: {
      kind: value.kind,
      number: value.number,
      intent: value.intent,
      target: value.target,
      bead_id: value.bead_id,
      resolved_session_name: value.resolved_session_name,
    },
  };
}

function invalidPrepared(message: string): PrepareMaintainerSlingRequestResult {
  return { status: 'error', message };
}

function invalidRecord(message: string): DecodeMaintainerSlingRecordResult {
  return { status: 'error', message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSlingIntent(value: unknown): value is SlingIntent {
  return value === 'review' || value === 'draft' || value === 'triage';
}

function isSlingKind(value: unknown): value is SlingKind {
  return value === 'pr' || value === 'issue';
}

function isValidIssueNumber(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 2_147_483_647
  );
}

function composeBeadText(intent: SlingIntent, htmlUrl: string): string {
  switch (intent) {
    case 'review':
      return `Please review PR ${htmlUrl}`;
    case 'draft':
      return `Please draft a PR addressing ${htmlUrl}`;
    case 'triage':
      return `Please triage ${htmlUrl}`;
  }
}
