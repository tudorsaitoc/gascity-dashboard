import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { StatusBody } from 'gas-city-dashboard-shared/gc-supervisor';
import type { SupervisorStatusReport } from 'gas-city-dashboard-shared';
import {
  createSupervisorStatusSampler,
  supervisorStatusRouter,
  type SamplerRuntime,
  type SamplerTimer,
} from './supervisor-status.js';

function statusBody(partial: Partial<StatusBody> = {}): StatusBody {
  return {
    agent_count: 0,
    agents: { quarantined: 0, running: 0, suspended: 0, total: 0 },
    mail: { total: 0, unread: 0 },
    name: 'test-city',
    path: '/tmp/test-city',
    rig_count: 0,
    rigs: { suspended: 0, total: 0 },
    running: 0,
    suspended: false,
    uptime_sec: 1,
    work: { in_progress: 0, open: 0, ready: 0 },
    ...partial,
  };
}

// A SamplerRuntime that never fires the timer, so tests drive sampleOnce()
// explicitly and assert the cached report — no wall-clock dependence.
const inertRuntime: SamplerRuntime = {
  setInterval: (): SamplerTimer => ({ unref: () => {} }),
  clearInterval: () => {},
};

describe('createSupervisorStatusSampler', () => {
  test('reports not_sampled_yet before the first sample', () => {
    const sampler = createSupervisorStatusSampler({
      fetchStatus: () => Promise.resolve(statusBody()),
      runtime: inertRuntime,
    });
    assert.deepEqual(sampler.report(), {
      available: false,
      reason: 'not_sampled_yet',
      status: null,
    });
  });

  test('caches the supervisor status and serves it after a successful sample', async () => {
    const status = statusBody({ work: { in_progress: 3, open: 7, ready: 5 } });
    const sampler = createSupervisorStatusSampler({
      fetchStatus: () => Promise.resolve(status),
      runtime: inertRuntime,
      now: () => '2026-06-07T00:00:00.000Z',
    });
    await sampler.sampleOnce();
    assert.deepEqual(sampler.report(), {
      available: true,
      sampledAt: '2026-06-07T00:00:00.000Z',
      status,
    });
  });

  test('retains the last good status across a later failed read (degraded, not blank)', async () => {
    const good = statusBody({ work: { in_progress: 1, open: 2, ready: 3 } });
    let fail = false;
    const sampler = createSupervisorStatusSampler({
      fetchStatus: () => (fail ? Promise.reject(new Error('slow /status')) : Promise.resolve(good)),
      runtime: inertRuntime,
      now: () => '2026-06-07T00:00:00.000Z',
    });
    await sampler.sampleOnce();
    fail = true;
    await sampler.sampleOnce();
    assert.deepEqual(sampler.report(), {
      available: false,
      reason: 'status_read_failed',
      status: good,
    });
  });
});

async function startApp(
  app: express.Express,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

describe('supervisorStatusRouter', () => {
  test('GET / serves the sampler report as JSON', async () => {
    const status = statusBody({ work: { in_progress: 9, open: 1, ready: 0 } });
    const sampler = createSupervisorStatusSampler({
      fetchStatus: () => Promise.resolve(status),
      runtime: inertRuntime,
      now: () => '2026-06-07T00:00:00.000Z',
    });
    await sampler.sampleOnce();

    const app = express();
    app.use('/api/city/test-city/supervisor-status', supervisorStatusRouter(sampler));
    const { url, close } = await startApp(app);
    try {
      const res = await fetch(`${url}/api/city/test-city/supervisor-status`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as SupervisorStatusReport;
      assert.equal(body.available, true);
      assert.deepEqual(body.status, status);
    } finally {
      await close();
    }
  });
});
