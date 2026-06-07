import fs from 'node:fs/promises';
import { type AdminAuditEvent } from 'gas-city-dashboard-shared';
import { LOG_COMPONENT, errorMessage, logError } from './logging.js';

// Audit log writer. Appends one JSON-per-line entry to .gc/events.jsonl —
// the same durable channel gc uses, which survives dolt-hq corruption
// (per architect's design). Single writer, single file; we tolerate
// concurrent appends because fs.appendFile is atomic-at-line for
// reasonable sizes on POSIX.

let logPath = process.env.HOME ? `${process.env.HOME}/.gc/events.jsonl` : '.gc/events.jsonl';

// Default actor recorded on audit rows that don't override it. Set at boot
// from AdminConfig.operatorAlias (gascity-dashboard-bhvn / zero-hardcoded-roles)
// so our operator is never baked into source; the neutral default covers the
// pre-boot/test window.
let auditActor = 'operator';

export function setAuditLogPath(p: string): void {
  logPath = p;
}

export function setAuditActor(actor: string): void {
  auditActor = actor;
}

export async function recordAudit(
  event: Omit<AdminAuditEvent, 'ts' | 'actor'> & Partial<Pick<AdminAuditEvent, 'actor'>>,
): Promise<void> {
  const row: AdminAuditEvent = {
    actor: auditActor,
    ts: new Date().toISOString(),
    ...event,
  };
  try {
    await fs.appendFile(logPath, JSON.stringify(row) + '\n', 'utf-8');
  } catch (err) {
    // Audit-log write failures are operationally important but should
    // never crash the request path. Surface via stderr only.
    logError(LOG_COMPONENT.adminAudit, `write failed: ${errorMessage(err)}`);
  }
}
