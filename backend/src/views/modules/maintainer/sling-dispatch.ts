import type {
  MaintainerSlingRecordRequest,
  MaintainerTriage,
} from 'gas-city-dashboard-shared';
import { recordAudit } from '../../../audit.js';
import { LOG_COMPONENT, errorMessage, logWarn } from '../../../logging.js';
import { slungKey, writeSlungEntry } from './slung-state.js';
import { notifyRefresh as notifyMaintainerRefresh } from './sse.js';

export interface RecordMaintainerSlingDeps {
  readonly repo: string;
  readonly slungStatePath: string;
  readonly notifyRefresh?: (payload: Pick<MaintainerTriage, 'computed_at' | 'repo'>) => void;
}

export interface RecordMaintainerSlingResult {
  readonly beadId: string | null;
}

export async function recordMaintainerSling(
  record: MaintainerSlingRecordRequest,
  deps: RecordMaintainerSlingDeps,
): Promise<RecordMaintainerSlingResult> {
  const startedAt = Date.now();
  await recordAudit({
    type: 'dashboard.sling',
    endpoint: 'POST /api/maintainer/sling-record',
    parsed_args: auditArgs(record),
    duration_ms: Date.now() - startedAt,
  });

  try {
    await writeSlungEntry(deps.slungStatePath, slungKey(record.kind, record.number), {
      slung_at: new Date().toISOString(),
      target: record.target,
      bead_id: record.bead_id,
      resolved_session_name: record.resolved_session_name,
    });
  } catch (slungErr) {
    logWarn(
      LOG_COMPONENT.maintainer,
      `slung-state write failed (sling already succeeded): ${errorMessage(slungErr)}`,
    );
  }

  const notify = deps.notifyRefresh ?? notifyMaintainerRefresh;
  notify({ computed_at: null, repo: deps.repo });
  return { beadId: record.bead_id };
}

function auditArgs(record: MaintainerSlingRecordRequest): Record<string, string> {
  const args: Record<string, string> = {
    kind: record.kind,
    number: String(record.number),
    intent: record.intent,
    target: record.target,
  };
  if (record.bead_id !== null) args.bead_id = record.bead_id;
  if (record.resolved_session_name !== null) {
    args.resolved_session_name = record.resolved_session_name;
  }
  return args;
}
