import { z } from 'zod';
import { sanitiseTerminalOutput } from './exec.js';
import type {
  CityList,
  GcAgent,
  GcAgentList,
  GcBead,
  GcBeadList,
  GcEventList,
  GcFormulaDetail,
  GcFormulaRunList,
  GcFormulaRunsResponse,
  GcMailList,
  GcOrderHistoryDetail,
  GcOrderHistoryList,
  GcOrdersFeedResponse,
  GcRigList,
  GcSessionList,
  GcStatus,
  GcWorkflowSnapshot,
  SupervisorHealth,
  TranscriptTurn,
} from 'gas-city-dashboard-shared';
import type { components } from './generated/gc-supervisor.js';

type RawSupervisorSchema = components['schemas'];

/**
 * Decoder-edge type for the supervisor's session-transcript response.
 * Intentionally local to the backend — this is the raw decoded shape,
 * NOT a wire-shape that crosses the dashboard's own API boundary. It is
 * assembled into the public `TranscriptResult` (from shared/) by
 * `buildTranscriptResult()` in routes/sessions.ts. Do not move to shared/.
 */
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

// 6bv7 F10: provider, running, session_name, title are declared REQUIRED in
// OpenAPI SessionResponse and present in 73/73 live sessions. Tighten here
// so a future supervisor that drops one of them fails at the decoder edge
// instead of leaking undefined into UI code that no longer guards for it.
const SessionSchema = z.object({
  id: z.string(),
  template: z.string(),
  state: z.string(),
  created_at: z.string(),
  attached: z.boolean(),
  provider: z.string(),
  running: z.boolean(),
  session_name: z.string(),
  title: z.string(),
  alias: z.string().optional(),
  reason: z.string().optional(),
  display_name: z.string().optional(),
  last_active: z.string().optional(),
  rig: z.string().optional(),
  pool: z.string().optional(),
  agent_kind: z.string().optional(),
  model: z.string().optional(),
  activity: z.string().optional(),
  context_pct: z.number().finite().optional(),
  context_window: z.number().finite().optional(),
}).passthrough();

// 6bv7 F15: structured dependency rows surfaced under OpenAPI Bead.dependencies.
const BeadDepSchema = z.object({
  depends_on_id: z.string(),
  issue_id: z.string(),
  type: z.string(),
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
  // serialization/deserialization at the edges". (Merged from PR #34's
  // upstream priority-null fix; .transform() is this wave's Phase 4
  // tightening.)
  priority: z.number().finite().nullish().transform((v) => v ?? null),
  created_at: z.string(),
  description: z.string().optional(),
  assignee: z.string().optional(),
  ref: z.string().optional(),
  labels: z.array(z.string()).optional(),
  // 6bv7 F11: OpenAPI Bead.metadata is declared as `{[key: string]: string}`.
  // Tighten to StringRecordSchema so consumers can drop the defensive
  // `typeof === 'string'` checks that were guarding against the prior
  // UnknownRecordSchema laundering arbitrary value types through the SSOT.
  metadata: StringRecordSchema.optional(),
  // 6bv7 F15: parent/from/ephemeral/needs/dependencies are emitted in live
  // data and declared in the OpenAPI Bead schema; surfacing them eliminates
  // the `as any` casts callers were using to read them off passthrough().
  parent: z.string().optional(),
  from: z.string().optional(),
  ephemeral: z.boolean().optional(),
  needs: z.array(z.string()).nullable().optional(),
  dependencies: z.array(BeadDepSchema).nullable().optional(),
}).passthrough();

// Per-rig wire shape from `GET /v0/city/{name}/rigs`. The supervisor's
// RigResponse carries agent_count, running_count, suspended, git status,
// default_branch, prefix, last_activity — all of which we drop at the
// edge because GcRig (shared) is intentionally narrow (name + path
// only). Adding a field to GcRig means widening this schema first so the
// SSOT contract stays one-way: shared.GcRig ⊆ supervisor.RigResponse.
// gascity-dashboard-19w.
const RigSchema = z.object({
  name: z.string(),
  path: z.string(),
}).passthrough();

// gascity-dashboard-ucc: GET /v0/cities item shape. The supervisor's
// CityInfo carries an absolute host `path` (and `phases_completed`); the
// dashboard NARROWS to name+running+status+error. Unlike the other
// supervisor decoders this one deliberately STRIPS unknown keys (Zod's
// default object behaviour — no `.passthrough()`) so the untrusted host
// `path` is removed at the decoder edge and can never reach the browser
// through `GET /api/cities`. A new supervisor field is dropped, not
// leaked; adopting one requires an explicit shared-types + schema change.
const CitySchema = z.object({
  name: z.string(),
  running: z.boolean(),
  status: z.string().optional(),
  error: z.string().optional(),
});

// Host-side city descriptor: same as CitySchema but RETAINS the untrusted
// host `path` (required string). Used only by the per-city runtime registry,
// never serialized to the browser. See `listSupervisorCities`.
const SupervisorCitySchema = z.object({
  name: z.string(),
  path: z.string(),
  running: z.boolean(),
}).passthrough();

/** Host-side city descriptor including the untrusted supervisor host path. */
export interface SupervisorCity {
  name: string;
  path: string;
  running: boolean;
}

// Per-agent wire shape from `GET /v0/city/{name}/agents` and
// `GET /v0/city/{name}/agent/{base}`. Mirrors the supervisor's
// AgentResponse schema (backend/src/generated/gc-supervisor.ts:2070).
// gascity-dashboard-ay6.
//
// Required fields per OpenAPI: name, available, running, suspended,
// state. Embedded `session` is the supervisor's `SessionInfo` shape —
// only `attached` + `name` are required there; `last_activity` is
// optional. Absent `session` means the agent is configured but does not
// currently have a running supervisor session (the canonical case the
// session-derived path under-counted).
const AgentSessionSchema = z.object({
  name: z.string(),
  attached: z.boolean(),
  last_activity: z.string().optional(),
}).passthrough();

const AgentSchema = z.object({
  name: z.string(),
  available: z.boolean(),
  running: z.boolean(),
  suspended: z.boolean(),
  state: z.string(),
  display_name: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  pool: z.string().optional(),
  rig: z.string().optional(),
  activity: z.string().optional(),
  context_pct: z.number().finite().optional(),
  context_window: z.number().finite().optional(),
  unavailable_reason: z.string().optional(),
  session: AgentSessionSchema.optional(),
}).passthrough();

// 6bv7 F17: priority/cc/reply_to live in OpenAPI Message but were missing
// from the decoder, forcing callers that wanted them to `as any` past
// passthrough(). Surface them so the SSOT contract covers the full Message.
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
  priority: z.number().finite().optional(),
  cc: z.array(z.string()).nullable().optional(),
  reply_to: z.string().optional(),
}).passthrough();

// 6bv7 F12: actor + payload are declared REQUIRED across every
// TypedEventStreamEnvelope variant in OpenAPI and present in 200/200
// sampled live events. Tighten to required so a future supervisor that
// drops one fails at the decoder edge.
const EventSchema = z.object({
  seq: z.number().finite(),
  type: z.string(),
  ts: z.string(),
  actor: z.string(),
  payload: UnknownRecordSchema,
  subject: z.string().optional(),
  message: z.string().optional(),
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

// 6bv7 F19: OpenAPI FormulaPreviewNodeResponse declares title + kind REQUIRED.
const FormulaPreviewNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.string(),
}).passthrough();

const FormulaPreviewEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.string().optional(),
}).passthrough();

// Supervisor's OpenAPI declares LogicalNode and ScopeGroup as
// `{additionalProperties: false, type: 'object'}` — always-empty objects.
// Shared types them as `Record<string, never>[]`; mirroring with an empty
// Zod object preserves the SSOT contract. (Previously used
// UnknownRecordSchema, which accepted any keys and laundered the
// mismatch via the t5l6 decoder cast.)
//
// Intentionally no .passthrough(): the rest of this file's schemas allow
// passthrough at the top level so the decoder remains forward-compatible
// with unknown supervisor fields, but THIS schema must strip unknown keys
// to remain a faithful surface for Record<string, never>. Adding
// .passthrough() here would widen the element type back to
// {[k: string]: unknown}, defeating the SSOT alignment.
const EmptyObjectSchema = z.object({});

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
  logical_nodes: z.array(EmptyObjectSchema).nullable(),
  logical_edges: z.array(WorkflowDepSchema).nullable(),
  scope_groups: z.array(EmptyObjectSchema).nullable(),
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

// gascity-dashboard-ej9y: one entry from /v0/city/<city>/formulas/feed.
// Mirrors supervisor `MonitorFeedItemResponse`. Used by the workflows
// snapshot collector to discover rig-stored workflow roots that the
// city-scoped listBeads endpoint does NOT return.
const FormulaRunSchema = z.object({
  id: z.string(),
  type: z.string(),
  status: z.string(),
  title: z.string(),
  scope_kind: z.string(),
  scope_ref: z.string(),
  target: z.string(),
  started_at: z.string(),
  updated_at: z.string(),
  workflow_id: z.string().optional(),
  root_bead_id: z.string().optional(),
  root_store_ref: z.string().optional(),
  attached_bead_id: z.string().optional(),
  logical_bead_id: z.string().optional(),
  bead_id: z.string().optional(),
  store_ref: z.string().optional(),
  detail_available: z.boolean().optional(),
  run_detail_available: z.boolean().optional(),
}).passthrough();

// gascity-dashboard-hvx: per-formula run history. One entry from
// FormulaRunsResponse.recent_runs. Mirrors supervisor `FormulaRecentRunResponse`
// — workflow_id + target + status + the two timestamps are all required.
const FormulaRecentRunSchema = z.object({
  workflow_id: z.string(),
  target: z.string(),
  status: z.string(),
  started_at: z.string(),
  updated_at: z.string(),
}).passthrough();

// gascity-dashboard-hvx: one entry from OrderHistoryListBody.entries.
// Mirrors supervisor `OrderHistoryEntry`. duration_ms / exit_code / signal
// are strings on the wire — the supervisor formats numerics for downstream
// consumers; preserved as-is so the SSOT contract stays one-way:
// shared.GcOrderHistoryEntry ⊆ supervisor.OrderHistoryEntry. `labels` is
// declared `T[] | null` (required + nullable) — preserve null so consumers
// can distinguish "no labels" from "missing field" (the latter must fail
// decoding instead of laundering into null).
const OrderHistoryEntrySchema = z.object({
  bead_id: z.string(),
  name: z.string(),
  scoped_name: z.string(),
  created_at: z.string(),
  capture_output: z.boolean(),
  has_output: z.boolean(),
  labels: z.array(z.string()).nullable(),
  store_ref: z.string(),
  duration_ms: z.string().optional(),
  exit_code: z.string().optional(),
  signal: z.string().optional(),
  error: z.string().optional(),
  rig: z.string().optional(),
  wisp_root_id: z.string().optional(),
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

// gascity-dashboard-x82: the supervisor's StatusBody.store_health summary.
// `size_bytes` is the only field the dashboard reads (dolt-noms trend); the
// rest are surfaced for the single-source-of-truth shape but unused today.
// `.finite()` on size_bytes rejects a malformed Infinity/NaN at the decoder
// edge; the sampler additionally rejects negative values (see routes/dolt.ts).
// store_health is optional on StatusBody — a degraded supervisor omits it.
const StatusStoreHealthSchema = z.object({
  size_bytes: z.number().finite(),
  live_rows: z.number().finite().optional(),
  ratio_mb_per_row: z.number().finite().optional(),
  last_gc_at: z.string().optional(),
}).passthrough();

const StatusSchema = z.object({
  store_health: StatusStoreHealthSchema.optional(),
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
// The supervisor's OpenAPI declares `partial` as optional on ListBodyBead,
// ListBodySessionResponse, MailListBody, and ListBodyWireEvent — `PartialField`
// mirrors that contract. FormulaFeedBody is the lone outlier: its `partial` is
// declared `boolean` (required), so `listFormulaRuns` uses `RequiredPartialField`
// instead. Keeping the two named helpers separate prevents the wire-shape drift
// from leaking back into the optional-side decoders.
const PartialField = z.boolean().optional();
const RequiredPartialField = z.boolean();
const PartialErrorsField = z.array(z.string())
  .nullish()
  .transform((v) => (v ?? undefined));

export const gcSupervisorDecoders = {
  listSessions(value: RawSupervisorSchema['ListBodySessionResponse']): GcSessionList {
    return decodeSupervisorPayload(
      z.object({
        items: listItemsField(SessionSchema),
        // 6bv7 F14: OpenAPI ListBodySessionResponse declares total required.
        total: z.number().finite(),
        partial: PartialField,
        partial_errors: PartialErrorsField,
      }).passthrough(),
      value,
      'listSessions',
    );
  },

  listRigs(value: RawSupervisorSchema['ListBodyRigResponse']): GcRigList {
    return decodeSupervisorPayload(
      z.object({
        items: listItemsField(RigSchema),
        partial: PartialField,
        partial_errors: PartialErrorsField,
      }).passthrough(),
      value,
      'listRigs',
    );
  },

  listCities(value: RawSupervisorSchema['SupervisorCitiesOutputBody']): CityList {
    return decodeSupervisorPayload(
      z.object({
        items: listItemsField(CitySchema),
        // SupervisorCitiesOutputBody declares total required.
        total: z.number().finite(),
      }).passthrough(),
      value,
      'listCities',
    );
  },

  // Host-side variant of listCities that RETAINS the untrusted host `path`.
  // The per-city runtime registry needs the path to build each city's
  // CLI-shelling routes; it is kept host-side and NEVER serialized to the
  // browser (the wire-shape `listCities` above strips it). Validates the
  // SAME required fields plus a required string `path`.
  listSupervisorCities(
    value: RawSupervisorSchema['SupervisorCitiesOutputBody'],
  ): readonly SupervisorCity[] {
    const decoded = decodeSupervisorPayload<{
      items: SupervisorCity[];
      total: number;
    }>(
      z.object({
        items: listItemsField(SupervisorCitySchema),
        total: z.number().finite(),
      }).passthrough(),
      value,
      'listSupervisorCities',
    );
    return decoded.items;
  },

  listAgents(value: RawSupervisorSchema['ListBodyAgentResponse']): GcAgentList {
    return decodeSupervisorPayload(
      z.object({
        items: listItemsField(AgentSchema),
        partial: PartialField,
        partial_errors: PartialErrorsField,
      }).passthrough(),
      value,
      'listAgents',
    );
  },

  getAgent(value: RawSupervisorSchema['AgentResponse']): GcAgent {
    return decodeSupervisorPayload(AgentSchema, value, 'getAgent');
  },

  getBead(value: RawSupervisorSchema['Bead']): GcBead {
    return decodeSupervisorPayload(BeadSchema, value, 'getBead');
  },

  listBeads(value: RawSupervisorSchema['ListBodyBead']): GcBeadList {
    return decodeSupervisorPayload(
      z.object({
        items: listItemsField(BeadSchema),
        // 6bv7 F14: OpenAPI ListBodyBead declares total required.
        total: z.number().finite(),
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
        // 6bv7 F14: OpenAPI MailListBody declares total required.
        total: z.number().finite(),
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
        // 6bv7 F13/F14: OpenAPI ListBodyWireEvent declares total required and
        // has no `next` field — only `next_cursor: string`. The previous
        // `next: z.number()` schema bound to a phantom field; passthrough()
        // strips it cleanly.
        total: z.number().finite(),
        partial: PartialField,
        partial_errors: PartialErrorsField,
      }).passthrough(),
      value,
      'listEvents',
    );
  },

  listFormulaRuns(value: RawSupervisorSchema['FormulaFeedBody']): GcFormulaRunList {
    return decodeSupervisorPayload(
      z.object({
        items: listItemsField(FormulaRunSchema),
        // mfb9: FormulaFeedBody.partial is required (`boolean`) per OpenAPI —
        // unlike its List* siblings whose `partial` is optional. The required
        // helper here locks the dashboard-side contract so a missing field
        // surfaces at the decoder edge instead of silently becoming `undefined`.
        partial: RequiredPartialField,
        partial_errors: PartialErrorsField,
      }).passthrough(),
      value,
      'listFormulaRuns',
    );
  },

  // gascity-dashboard-hvx: per-formula recent runs. Distinct from
  // listFormulaRuns (cross-formula /formulas/feed) — this is the supervisor's
  // `formulas/{name}/runs` endpoint, scoped to a single named formula.
  // FormulaRunsResponse declares `formula` + `run_count` + `partial`
  // required; `recent_runs` is `T[] | null` (the listItemsField pattern).
  listFormulaRunsByName(value: RawSupervisorSchema['FormulaRunsResponse']): GcFormulaRunsResponse {
    return decodeSupervisorPayload(
      z.object({
        formula: z.string(),
        run_count: z.number().finite(),
        recent_runs: listItemsField(FormulaRecentRunSchema),
        partial: RequiredPartialField,
        partial_errors: PartialErrorsField,
      }).passthrough(),
      value,
      'listFormulaRunsByName',
    );
  },

  // gascity-dashboard-hvx: orders/feed shares the per-item shape
  // (MonitorFeedItemResponse) with formulas/feed — reuse FormulaRunSchema.
  // OrdersFeedBody.partial is required (mirrors FormulaFeedBody).
  listOrdersFeed(value: RawSupervisorSchema['OrdersFeedBody']): GcOrdersFeedResponse {
    return decodeSupervisorPayload(
      z.object({
        items: listItemsField(FormulaRunSchema),
        partial: RequiredPartialField,
        partial_errors: PartialErrorsField,
      }).passthrough(),
      value,
      'listOrdersFeed',
    );
  },

  // gascity-dashboard-hvx: full history for one named order. The supervisor's
  // OrderHistoryListBody is intentionally narrow — entries only, no
  // partial/partial_errors/total envelope. `entries: T[] | null` follows the
  // listItemsField pattern.
  listOrderHistory(value: RawSupervisorSchema['OrderHistoryListBody']): GcOrderHistoryList {
    return decodeSupervisorPayload(
      z.object({
        entries: listItemsField(OrderHistoryEntrySchema),
      }).passthrough(),
      value,
      'listOrderHistory',
    );
  },

  // gascity-dashboard-hvx: one historical order-run detail. All five fields
  // declared required in OpenAPI; `labels` is `T[] | null` (preserve null so
  // consumers can distinguish "no labels" from "missing field").
  //
  // hvx.1: `output` is captured terminal stdout/stderr — the same surface
  // `fetchTranscript` runs through `sanitiseTerminalOutput`. We apply
  // sanitisation at the DECODER edge (not the route handler) so any future
  // route that surfaces this field cannot bypass the contract by forgetting
  // to call the sanitiser. Defense-in-depth per the Phase-4 security review
  // on the cleanup wave.
  getOrderHistoryDetail(value: RawSupervisorSchema['OrderHistoryDetailResponse']): GcOrderHistoryDetail {
    return decodeSupervisorPayload(
      z.object({
        bead_id: z.string(),
        store_ref: z.string(),
        created_at: z.string(),
        labels: z.array(z.string()).nullable(),
        output: z.string().transform(sanitiseTerminalOutput),
      }).passthrough(),
      value,
      'getOrderHistoryDetail',
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

  getStatus(value: RawSupervisorSchema['StatusBody']): GcStatus {
    return decodeSupervisorPayload(StatusSchema, value, 'getStatus');
  },
} as const;

// gascity-dashboard-t5l6: `z.ZodType<SchemaOutputFor<NoInfer<Decoded>>>`
// (not the bare `z.ZodType`) is load-bearing. It ties the Zod schema's
// output to the caller-declared `Decoded` so tsc rejects schemas whose
// parsed shape diverges from the shared SSOT type — see SchemaOutputFor
// + NoInfer below for the mechanics. The previous `as Decoded` cast
// laundered any schema into any return type, silently defeating the
// wire-shape contract. Verified by
// backend/test/gc-supervisor-decoders-types.test.ts.
function decodeSupervisorPayload<Decoded>(
  schema: z.ZodType<SchemaOutputFor<NoInfer<Decoded>>>,
  value: unknown,
  payload: string,
): Decoded {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw invalid(payload, parsed.error);
  }
  // `parsed.data` is `SchemaOutputFor<Decoded>` — structurally identical
  // to `Decoded` at runtime but TS-noisier on optional fields (see
  // SchemaOutputFor comment). Narrow, documented cast — not the
  // unconstrained `as Decoded` laundering removed by t5l6.
  return parsed.data as Decoded;
}

// Maps a shared SSOT type into the structural shape a Zod schema is
// expected to emit. For every property:
//   - required `foo: T`  → required `foo: SchemaOutputFor<T>`
//   - optional `foo?: T` → optional `foo?: SchemaOutputFor<T> | undefined`
// (the second form is what Zod's `.optional()` produces under the
// project's `exactOptionalPropertyTypes: true` — Zod's runtime emission
// matches `foo?: T` exactly, but its TS-level output type is noisier).
// Recurses through array element types so nested shared interfaces (e.g.
// `GcBeadList.items: GcBead[]`) are loosened consistently. Paired with
// `NoInfer<Decoded>` in `decodeSupervisorPayload` so `Decoded` binds from
// the caller's return-type context, not from the schema parameter.
type SchemaOutputFor<T> =
  T extends readonly (infer U)[]
    ? SchemaOutputFor<U>[]
    : T extends object
      ?
          & { [K in RequiredKeysOf<T>]: SchemaOutputFor<T[K]> }
          & { [K in OptionalKeysOf<T>]?: SchemaOutputFor<T[K]> | undefined }
      : T;

// The `{}` here is the canonical structural-equivalence trick for
// detecting optional vs required keys (an empty object satisfies a Pick
// of an optional field, but never a required one). Disabling the
// no-empty-object-type rule for these two lines is the intent per
// the rule's own documented remediation.
type RequiredKeysOf<T> = {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  [K in keyof T]-?: {} extends Pick<T, K> ? never : K;
}[keyof T];

type OptionalKeysOf<T> = {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  [K in keyof T]-?: {} extends Pick<T, K> ? K : never;
}[keyof T];

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
    // The path segment is a supervisor-controlled key (e.g. a metadata
    // key after 6bv7 F11). Strip CR/LF so a malicious or buggy
    // supervisor that emits a key like `"evil\n[component] forged log"`
    // cannot forge a line into the dashboard's logs when this error
    // surfaces through logWarn (route-errors / snapshot/cache).
    return `.${String(part).replace(/[\r\n]/g, '_')}`;
  }).join('')}`;
}

type ZodIssue = z.ZodError['issues'][number];

function zodExpected(issue: ZodIssue): string {
  if (issue.code === 'invalid_type' && 'expected' in issue) {
    if ('input' in issue && issue.input === undefined) return 'present';
    return String(issue.expected);
  }
  // Fallback for non-invalid_type issues (invalid_value, invalid_format,
  // too_small, etc.). Zod's built-in `issue.message` may embed the received
  // value (e.g. invalid_value in Zod 4 includes the input). Even though
  // toWireInternal500 strips the message to details.name before serving, the
  // server-side log line still carries supervisor data through this path —
  // return a fixed shape keyed on the discriminator code instead so the log
  // is value-free by construction.
  return `valid (${issue.code})`;
}
