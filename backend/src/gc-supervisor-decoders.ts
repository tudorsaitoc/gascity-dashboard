import type {
  GcBead,
  GcBeadList,
  GcEventList,
  GcFormulaDetail,
  GcMailList,
  GcRunSnapshot,
  GcSessionList,
  SupervisorHealth,
  TranscriptTurn,
} from 'gas-city-dashboard-shared';
import { z } from 'zod';
import {
  openApiIssuePath,
  validateGcSupervisorComponent,
} from './gc-supervisor-schema-validator.js';
import type { components } from './generated/gc-supervisor.js';

type RawSupervisorSchema = components['schemas'];

export interface GcTranscriptResponse {
  id?: string;
  template?: string;
  provider?: string;
  format?: string;
  turns: TranscriptTurn[];
}

export type GcDecoder<RawValue, DecodedValue> = (value: RawValue) => DecodedValue;

type GcWorkflowSnapshot = Omit<GcRunSnapshot, 'run_id'> & {
  workflow_id: string;
};

const UnknownRecordSchema = z.record(z.string(), z.unknown());
const StringRecordSchema = z.record(z.string(), z.string());

const SessionSchema = z.object({
  id: z.string(),
  template: z.string(),
  state: z.string(),
  created_at: z.string(),
  attached: z.boolean(),
  alias: z.string().optional(),
  title: z.string().optional(),
  reason: z.string().optional(),
  display_name: z.string().optional(),
  session_name: z.string().optional(),
  last_active: z.string().optional(),
  rig: z.string().optional(),
  pool: z.string().optional(),
  agent_kind: z.string().optional(),
  model: z.string().optional(),
  activity: z.string().optional(),
  running: z.boolean().optional(),
  context_pct: z.number().finite().optional(),
  context_window: z.number().finite().optional(),
}).passthrough();

const BeadSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  issue_type: z.string(),
  // The supervisor sends priority: null for non-engineering beads (messages,
  // sessions, etc.) and the OpenAPI spec declares it optional. Accept both
  // null and missing — the dashboard's downstream consumers must handle it.
  priority: z.number().finite().nullish(),
  created_at: z.string(),
  description: z.string().optional(),
  owner: z.string().optional(),
  assignee: z.string().optional(),
  updated_at: z.string().optional(),
  closed_at: z.string().optional(),
  ref: z.string().optional(),
  labels: z.array(z.string()).optional(),
  dependency_count: z.number().finite().optional(),
  dependent_count: z.number().finite().optional(),
  comment_count: z.number().finite().optional(),
  metadata: UnknownRecordSchema.optional(),
}).passthrough();

const MailItemSchema = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  subject: z.string(),
  body: z.string(),
  created_at: z.string(),
  read: z.boolean(),
  thread_id: z.string().optional(),
  rig: z.string().optional(),
}).passthrough();

const EventSchema = z.object({
  seq: z.number().finite(),
  type: z.string(),
  ts: z.string(),
  actor: z.string().optional(),
  subject: z.string().optional(),
  message: z.string().optional(),
  payload: UnknownRecordSchema.optional(),
}).passthrough();

const RunBeadSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  kind: z.string(),
  step_ref: z.string().optional(),
  attempt: z.number().finite().optional(),
  logical_bead_id: z.string().optional(),
  scope_ref: z.string().optional(),
  assignee: z.string().optional(),
  metadata: StringRecordSchema,
}).passthrough();

const RunDepSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.string().optional(),
}).passthrough();

const FormulaPreviewNodeSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  kind: z.string().optional(),
}).passthrough();

const FormulaPreviewEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.string().optional(),
}).passthrough();

const RunSnapshotBaseSchema = z.object({
  root_bead_id: z.string(),
  root_store_ref: z.string(),
  resolved_root_store: z.string(),
  scope_kind: z.string(),
  scope_ref: z.string(),
  snapshot_version: z.number().finite(),
  snapshot_event_seq: z.number().finite().nullable().optional(),
  partial: z.boolean(),
  stores_scanned: z.array(z.string()).nullable(),
  beads: z.array(RunBeadSchema).nullable(),
  deps: z.array(RunDepSchema).nullable(),
  logical_nodes: z.array(UnknownRecordSchema).nullable(),
  logical_edges: z.array(RunDepSchema).nullable(),
  scope_groups: z.array(UnknownRecordSchema).nullable(),
}).passthrough();

const WorkflowSnapshotSchema = RunSnapshotBaseSchema.extend({
  workflow_id: z.string(),
}).passthrough();

const FormulaDetailSchema = z.object({
  name: z.string(),
  preview: z.object({
    nodes: z.array(FormulaPreviewNodeSchema).optional(),
    edges: z.array(FormulaPreviewEdgeSchema).optional(),
  }).passthrough().optional(),
  steps: z.array(FormulaPreviewNodeSchema).optional(),
  deps: z.array(FormulaPreviewEdgeSchema).optional(),
}).passthrough();

const TranscriptTurnSchema = z.object({
  role: z.string(),
  text: z.string(),
}).passthrough();

const TranscriptResponseSchema = z.object({
  id: z.string().optional(),
  template: z.string().optional(),
  provider: z.string().optional(),
  format: z.string().optional(),
  turns: z.array(TranscriptTurnSchema),
}).passthrough();

const HealthSchema = z.object({
  status: z.string(),
  version: z.string(),
  city: z.string(),
  uptime_sec: z.number().finite(),
}).passthrough();

export const gcSupervisorDecoders = {
  listSessions(value: RawSupervisorSchema['ListBodySessionResponse']): GcSessionList {
    return decodeSupervisorPayload(
      'ListBodySessionResponse',
      z.object({ items: z.array(SessionSchema) }).passthrough(),
      value,
      'listSessions',
    );
  },

  getBead(value: RawSupervisorSchema['Bead']): GcBead {
    return decodeSupervisorPayload('Bead', BeadSchema, value, 'getBead');
  },

  listBeads(value: RawSupervisorSchema['ListBodyBead']): GcBeadList {
    return decodeSupervisorPayload(
      'ListBodyBead',
      z.object({
        items: z.array(BeadSchema),
        total: z.number().finite().optional(),
      }).passthrough(),
      value,
      'listBeads',
    );
  },

  listMail(value: RawSupervisorSchema['MailListBody']): GcMailList {
    return decodeSupervisorPayload(
      'MailListBody',
      z.object({
        items: z.array(MailItemSchema),
        total: z.number().finite().optional(),
      }).passthrough(),
      value,
      'listMail',
    );
  },

  listEvents(value: RawSupervisorSchema['ListBodyWireEvent']): GcEventList {
    return decodeSupervisorPayload(
      'ListBodyWireEvent',
      z.object({
        items: z.array(EventSchema),
        next: z.number().finite().optional(),
      }).passthrough(),
      value,
      'listEvents',
    );
  },

  getRun(value: RawSupervisorSchema['WorkflowSnapshotResponse']): GcRunSnapshot {
    const wire = decodeSupervisorPayload<GcWorkflowSnapshot>(
      'WorkflowSnapshotResponse',
      WorkflowSnapshotSchema,
      value,
      'getRun',
    );
    const {
      workflow_id: workflowId,
      snapshot_event_seq: snapshotEventSeq,
      ...rest
    } = wire;
    const snapshot: GcRunSnapshot = {
      ...rest,
      run_id: workflowId,
    };
    if (snapshotEventSeq !== undefined) {
      snapshot.snapshot_event_seq = snapshotEventSeq;
    }
    return snapshot;
  },

  getFormulaDetail(value: RawSupervisorSchema['FormulaDetailResponse']): GcFormulaDetail {
    return decodeSupervisorPayload(
      'FormulaDetailResponse',
      FormulaDetailSchema,
      value,
      'getFormulaDetail',
    );
  },

  fetchTranscript(value: RawSupervisorSchema['SessionTranscriptGetResponse']): GcTranscriptResponse {
    return decodeSupervisorPayload(
      'SessionTranscriptGetResponse',
      TranscriptResponseSchema,
      value,
      'fetchTranscript',
    );
  },

  health(value: RawSupervisorSchema['HealthOutputBody']): SupervisorHealth {
    return decodeSupervisorPayload(
      'HealthOutputBody',
      HealthSchema,
      value,
      'health',
    );
  },
} as const;

function decodeSupervisorPayload<Decoded>(
  componentName: string | null,
  schema: z.ZodType,
  value: unknown,
  payload: string,
): Decoded {
  if (componentName !== null) {
    const openApiIssue = validateGcSupervisorComponent(componentName, value);
    if (openApiIssue !== undefined) {
      throw invalidOpenApi(payload, openApiIssue);
    }
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw invalid(payload, parsed.error);
  }
  return parsed.data as Decoded;
}

function invalidOpenApi(
  payload: string,
  issue: { readonly path: readonly (string | number)[]; readonly expected: string },
): Error {
  return new Error(
    `invalid gc supervisor ${payload} payload: ${openApiIssuePath(issue.path)} must be ${issue.expected}`,
  );
}

function invalid(payload: string, error: z.ZodError): Error {
  const issue = error.issues[0];
  const path = issue ? zodPath(issue.path) : 'payload';
  const expected = issue ? zodExpected(issue) : 'valid';
  return new Error(
    `invalid gc supervisor ${payload} payload: ${path} must be ${expected}`,
  );
}

function zodPath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return 'payload';
  return `payload${path.map((part) => {
    if (typeof part === 'number') return `[${part}]`;
    return `.${String(part)}`;
  }).join('')}`;
}

type ZodIssue = z.ZodError['issues'][number];

function zodExpected(issue: ZodIssue): string {
  if (issue.code === 'invalid_type' && 'expected' in issue) {
    if ('input' in issue && issue.input === undefined) return 'present';
    return String(issue.expected);
  }
  return issue.message;
}
