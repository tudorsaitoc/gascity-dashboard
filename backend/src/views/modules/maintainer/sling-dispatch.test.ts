import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { setAuditLogPath } from '../../../audit.js';
import type { MaintainerSlingRecordRequest } from 'gas-city-dashboard-shared';
import { readSlungState } from './slung-state.js';
import { recordMaintainerSling } from './sling-dispatch.js';

interface TestPaths {
  readonly dir: string;
  readonly auditPath: string;
  readonly slungStatePath: string;
}

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function testPaths(): Promise<TestPaths> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sling-dispatch-test-'));
  tmpDirs.push(dir);
  const auditPath = path.join(dir, 'events.jsonl');
  setAuditLogPath(auditPath);
  return {
    dir,
    auditPath,
    slungStatePath: path.join(dir, 'slung-state.json'),
  };
}

async function readAudit(pathToAudit: string): Promise<Record<string, unknown>[]> {
  const raw = await fs.readFile(pathToAudit, 'utf-8');
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function record(
  overrides: Partial<MaintainerSlingRecordRequest> = {},
): MaintainerSlingRecordRequest {
  return {
    kind: 'pr',
    number: 47,
    intent: 'triage',
    target: 'chief-of-staff',
    bead_id: 'gc-255139',
    resolved_session_name: 'oversight-rig__chief-of-staff',
    ...overrides,
  };
}

describe('recordMaintainerSling', () => {
  test('audits, persists slung state, and notifies refresh without supervisor IO', async () => {
    const paths = await testPaths();
    const notifications: unknown[] = [];

    const result = await recordMaintainerSling(record(), {
      repo: 'gastownhall/gascity',
      slungStatePath: paths.slungStatePath,
      notifyRefresh: (payload) => notifications.push(payload),
    });

    assert.equal(result.beadId, 'gc-255139');

    const state = await readSlungState(paths.slungStatePath);
    const entry = state['pr:47'];
    assert.ok(entry);
    assert.equal(entry.target, 'chief-of-staff');
    assert.equal(entry.bead_id, 'gc-255139');
    assert.equal(entry.resolved_session_name, 'oversight-rig__chief-of-staff');

    assert.deepEqual(notifications, [{ computed_at: null, repo: 'gastownhall/gascity' }]);

    const [audit] = await readAudit(paths.auditPath);
    assert.equal(audit?.type, 'dashboard.sling');
    assert.equal(audit?.endpoint, 'POST /api/maintainer/sling-record');
    const parsed = audit?.parsed_args as Record<string, string>;
    assert.equal(parsed.kind, 'pr');
    assert.equal(parsed.number, '47');
    assert.equal(parsed.intent, 'triage');
    assert.equal(parsed.target, 'chief-of-staff');
    assert.equal(parsed.bead_id, 'gc-255139');
  });

  test('persists explicit null bead and unresolved session values', async () => {
    const paths = await testPaths();

    const result = await recordMaintainerSling(
      record({ bead_id: null, resolved_session_name: null }),
      {
        repo: 'gastownhall/gascity',
        slungStatePath: paths.slungStatePath,
      },
    );

    assert.equal(result.beadId, null);
    const state = await readSlungState(paths.slungStatePath);
    const entry = state['pr:47'];
    assert.ok(entry);
    assert.equal(entry.bead_id, null);
    assert.equal(entry.resolved_session_name, null);
  });
});
