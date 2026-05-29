import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { clientErrorsRouter } from '../src/routes/client-errors.js';
import { LOG_COMPONENT } from '../src/logging.js';

async function withRouter<T>(
  logs: string[],
  fn: (url: string) => Promise<T>,
): Promise<T> {
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use(
    '/api/client-errors',
    clientErrorsRouter({
      log: (component, message) => logs.push(`${component}:${message}`),
    }),
  );

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

describe('client error reporting route', () => {
  test('logs a validated browser error event', async () => {
    const logs: string[] = [];
    await withRouter(logs, async (url) => {
      const res = await fetch(`${url}/api/client-errors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          component: 'ThemeContext',
          operation: 'localStorage.getItem',
          message: 'storage blocked',
        }),
      });

      assert.equal(res.status, 202);
      assert.deepEqual(await res.json(), { ok: true });
    });

    assert.equal(logs.length, 1);
    assert.equal(
      logs[0],
      `${LOG_COMPONENT.client}:ThemeContext localStorage.getItem: storage blocked`,
    );
  });

  test('rejects malformed browser error events', async () => {
    const logs: string[] = [];
    await withRouter(logs, async (url) => {
      const res = await fetch(`${url}/api/client-errors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          component: 'ThemeContext',
          operation: '',
          message: 'storage blocked',
        }),
      });

      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), {
        error: 'operation must be a non-empty string',
        kind: 'validation',
      });
    });
    assert.deepEqual(logs, []);
  });

  // opj0 #1: ANSI / control characters in browser-supplied fields must not
  // survive into the operator log line. The whitespace-normalize step
  // (\s+ → ' ') only collapses CR/LF/TAB; ANSI escape sequences and the
  // remaining C0/C1 control bytes pass through unless explicitly stripped.
  // A hostile client could otherwise forge a fake `[component] message`
  // log line by embedding \x1b sequences + colour codes.
  test('strips ANSI escape sequences and control chars before logging', async () => {
    const logs: string[] = [];
    await withRouter(logs, async (url) => {
      const res = await fetch(`${url}/api/client-errors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          component: 'ThemeContext',
          operation: 'localStorage.getItem',
          // Embedded SGR colour code + control bytes + a forged-log attempt.
          message: 'storage \x1b[31mblocked\x1b[0m\x07\x08\n[admin] CRITICAL',
        }),
      });
      assert.equal(res.status, 202);
      assert.deepEqual(await res.json(), { ok: true });
    });

    assert.equal(logs.length, 1);
    const line = logs[0]!;
    // ANSI escape sequences are gone.
    assert.doesNotMatch(line, /\x1b/);
    // C0/C1 control bytes are gone.
    assert.doesNotMatch(line, /[\x00-\x1f\x7f]/);
    // The visible message survives, just without the escape sequences.
    assert.match(line, /storage blocked/);
    assert.match(line, /\[admin\] CRITICAL/);
  });
});
