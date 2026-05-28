import { z } from 'zod';
import type {
  GcBead,
  GcBeadList,
  GcEventList,
  GcFormulaDetail,
  GcMailList,
  GcSessionList,
  GcWorkflowSnapshot,
  SupervisorHealth,
  TranscriptTurn,
} from 'gas-city-dashboard-shared';
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
  // The supervisor's OpenAPI spec declares priority optional and in practice
  // sends `null` for non-engineering beads (messages, sessions, …). Accept
  // both null and missing, then collapse `undefined → null` at the decoder
  // edge so the typed interior (`GcBead.priority: number | null`) never sees
  // an `undefined` it isn't declared to handle. Per CLAUDE.md: "Keep
  // serialization/deserialization at the edges".
  priority: z.number().finite().nullish().transform((v) => v ?? null),
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

const WorkflowBeadSchema = z.object({
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

const WorkflowDepSchema = z.object({
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

const WorkflowSnapshotSchema = z.object({
  workflow_id: z.string(),
  root_bead_id: z.string(),
  root_store_ref: z.string(),
  resolved_root_store: z.string(),
  scope_kind: z.string(),
  scope_ref: z.string(),
  snapshot_version: z.number().finite(),
  snapshot_event_seq: z.number().finite().nullable().optional(),
  partial: z.boolean(),
  stores_scanned: z.array(z.string()).nullable(),
  beads: z.array(WorkflowBeadSchema).nullable(),
  deps: z.array(WorkflowDepSchema).nullable(),
  logical_nodes: z.array(UnknownRecordSchema).nullable(),
  logical_edges: z.array(WorkflowDepSchema).nullable(),
  scope_groups: z.array(UnknownRecordSchema).nullable(),
}).passthrough();

const FormulaDetailSchema = z.object({
  name: z.string(),
  preview: z.object({
    nodes: z.array(FormulaPreviewNodeSchema).optional(),
    edges: z.array(FormulaPreviewEdgeSchema).optional(),
  }).passthrough().optional(),
  // izgc F5/F6: OpenAPI declares steps/deps as `T[] | null` (required +
  // nullable). Accept null and missing, then collapse to undefined so the
  // typed interior (GcFormulaDetail.steps?: T[]) matches Zod output exactly
  // — bypasses the t5l6 cast-laundering bug without pulling it into scope.
  steps: z.array(FormulaPreviewNodeSchema).nullish().transform((v) => v ?? undefined),
  deps: z.array(FormulaPreviewEdgeSchema).nullish().transform((v) => v ?? undefined),
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
  // izgc F2: OpenAPI declares turns?: T[] | null (optional AND nullable).
  // Live raw-format responses already omit the key. Normalize null/missing
  // to [] at the edge so GcTranscriptResponse.turns stays non-null.
  turns: z.array(TranscriptTurnSchema).nullish().transform((v) => v ?? []),
}).passthrough();

const HealthSchema = z.object({
  status: z.string(),
  // izgc F7/F8: OpenAPI declares both city + version optional. Present in
  // practice today, but typing as required depends on supervisor
  // implementation details — a refactor could legitimately omit them.
  // Shared SupervisorHealth surfaces undefined as a warn-toned signal in
  // the Health UI rather than coalescing silently.
  version: z.string().optional(),
  city: z.string().optional(),
  uptime_sec: z.number().finite(),
}).passthrough();

// izgc F3: every ListBody* envelope in the supervisor's OpenAPI declares
// `items: T[] | null` for partial/degraded responses, correlated with
// `partial: true` and `partial_errors`. Build the list-decoder fields once
// so the four list shapes stay consistent: items collapses null → [], but
// the partial signal survives on the shared interface so consumers can
// surface degradation. Per CLAUDE.md "Don't Swallow Errors" + "Keep
// serialization/deserialization at the edges".
function listItemsField<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.array(itemSchema).nullish().transform((v) => v ?? []);
}
const PartialField = z.boolean().optional();
const PartialErrorsField = z.array(z.string())
  .nullish()
  .transform((v) => (v ?? undefined));

export const gcSupervisorDecoders = {
  listSessions(value: RawSupervisorSchema['ListBodySessionResponse']): GcSessionList {
    return decodeSupervisorPayload(
      z.object({
        items: listItemsField(SessionSchema),
        partial: PartialField,
        partial_errors: PartialErrorsField,
      }).passthrough(),
      value,
      'listSessions',
    );
  },

  getBead(value: RawSupervisorSchema['Bead']): GcBead {
    return decodeSupervisorPayload(BeadSchema, value, 'getBead');
  },

  listBeads(value: RawSupervisorSchema['ListBodyBead']): GcBeadList {
    return decodeSupervisorPayload(
      z.object({
        items: listItemsField(BeadSchema),
        total: z.number().finite().optional(),
        partial: PartialField,
        partial_errors: PartialErrorsField,
      }).passthrough(),
      value,
      'listBeads',
    );
  },

  listMail(value: RawSupervisorSchema['MailListBody']): GcMailList {
    return decodeSupervisorPayload(
      z.object({
        items: listItemsField(MailItemSchema),
        total: z.number().finite().optional(),
        partial: PartialField,
        partial_errors: PartialErrorsField,
      }).passthrough(),
      value,
      'listMail',
    );
  },

  listEvents(value: RawSupervisorSchema['ListBodyWireEvent']): GcEventList {
    return decodeSupervisorPayload(
      z.object({
        items: listItemsField(EventSchema),
        next: z.number().finite().optional(),
        partial: PartialField,
        partial_errors: PartialErrorsField,
      }).passthrough(),
      value,
      'listEvents',
    );
  },

  getWorkflow(value: RawSupervisorSchema['WorkflowSnapshotResponse']): GcWorkflowSnapshot {
    return decodeSupervisorPayload(WorkflowSnapshotSchema, value, 'getWorkflow');
  },

  getFormulaDetail(value: RawSupervisorSchema['FormulaDetailResponse']): GcFormulaDetail {
    return decodeSupervisorPayload(FormulaDetailSchema, value, 'getFormulaDetail');
  },

  fetchTranscript(value: RawSupervisorSchema['SessionTranscriptGetResponse']): GcTranscriptResponse {
    return decodeSupervisorPayload(TranscriptResponseSchema, value, 'fetchTranscript');
  },

  health(value: RawSupervisorSchema['HealthOutputBody']): SupervisorHealth {
    return decodeSupervisorPayload(HealthSchema, value, 'health');
  },
} as const;

function decodeSupervisorPayload<Decoded>(
  schema: z.ZodType,
  value: unknown,
  payload: string,
): Decoded {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw invalid(payload, parsed.error);
  }
  return parsed.data as Decoded;
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
