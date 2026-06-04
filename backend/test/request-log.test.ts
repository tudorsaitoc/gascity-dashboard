import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { requestLog } from '../src/middleware/request-log.js';
import { LOG_COMPONENT, REQUEST_ID_HEADER, currentRequestId } from '../src/logging.js';

async function withApp<T>(logs: string[], fn: (url: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(
    requestLog({
      log: (component, message) => logs.push(`${component}:${message}`),
    }),
  );
  app.get('/api/demo', (_req, res) => {
    res.status(201).json({ ok: true, request_id: currentRequestId() });
  });
  app.get('/api/snapshot', (_req, res) => {
    res.json({ ok: true });
  });

  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('requestLog middleware', () => {
  test('logs method, path, status, and duration after the response finishes', async () => {
    const logs: string[] = [];
    await withApp(logs, async (url) => {
      const res = await fetch(`${url}/api/demo?ignored=1`, {
        headers: { [REQUEST_ID_HEADER]: 'req-from-client' },
      });
      assert.equal(res.status, 201);
      assert.equal(res.headers.get(REQUEST_ID_HEADER), 'req-from-client');
      assert.deepEqual(await res.json(), { ok: true, request_id: 'req-from-client' });
    });

    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? '', new RegExp(`^${LOG_COMPONENT.admin}:GET /api/demo 201 \\d+ms$`));
  });

  test('generates a request id when the caller does not provide a safe one', async () => {
    const logs: string[] = [];
    await withApp(logs, async (url) => {
      const res = await fetch(`${url}/api/demo`, {
        headers: { [REQUEST_ID_HEADER]: 'bad request id' },
      });
      assert.equal(res.status, 201);
      const header = res.headers.get(REQUEST_ID_HEADER);
      assert.match(header ?? '', /^[0-9a-f-]{36}$/);
      assert.notEqual(header, 'bad request id');
      const body = (await res.json()) as { request_id: string };
      assert.equal(body.request_id, header);
    });

    assert.equal(logs.length, 1);
  });

  test('skips ambient snapshot polling', async () => {
    const logs: string[] = [];
    await withApp(logs, async (url) => {
      const res = await fetch(`${url}/api/snapshot`);
      assert.equal(res.status, 200);
    });

    assert.deepEqual(logs, []);
  });
});
