import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { beadsRouter } from '../src/routes/beads.js';

const TEST_CITY_PATH = '/home/test/gas-city';
const BEADS_WRITE_BASE = '/api/city/test-city/beads';

interface AppHandle {
  url: string;
  close: () => Promise<void>;
}

async function buildApp(): Promise<AppHandle> {
  const app = express();
  app.use(express.json());
  app.use(BEADS_WRITE_BASE, beadsRouter(TEST_CITY_PATH));

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

async function postJson(url: string, body: unknown = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('dashboard bead write route retirement', { concurrency: false }, () => {
  let h: AppHandle | undefined;
  afterEach(async () => {
    if (h !== undefined) await h.close();
    h = undefined;
  });

  test('claim is no longer exposed by the dashboard bead router', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}${BEADS_WRITE_BASE}/td-wisp-abc123/claim`);
    assert.equal(res.status, 404);
  });

  test('close is no longer exposed by the dashboard bead router', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}${BEADS_WRITE_BASE}/td-wisp-abc123/close`, {
      reason: 'operator verified duplicate',
    });
    assert.equal(res.status, 404);
  });

  test('nudge is no longer exposed by the dashboard bead router', async () => {
    h = await buildApp();
    const res = await postJson(`${h.url}${BEADS_WRITE_BASE}/td-wisp-abc123/nudge`, {
      agent_alias: 'mayor',
    });
    assert.equal(res.status, 404);
  });
});
