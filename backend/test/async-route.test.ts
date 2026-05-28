import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { maintainerRouter } from '../src/routes/maintainer.js';
import { apiErrorHandler } from '../src/middleware/api-error-handler.js';

async function startApp(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('async route rejection handling', () => {
  test('sanitizes rejected maintainer async handlers instead of leaking or hanging', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gascity-dashboard-maintainer-'));
    const cachePath = path.join(tmp, 'triage.json');
    await fs.writeFile(cachePath, '{not valid json', 'utf8');

    const app = express();
    app.use(
      '/api/maintainer',
      maintainerRouter({
        repo: 'gastownhall/gascity',
        cachePath,
        slingTarget: 'mayor',
        sling: async () => ({ root_bead_id: 'bd-123' }),
      }),
    );
    app.use(apiErrorHandler());

    const { url, close } = await startApp(app);
    try {
      const res = await fetch(`${url}/api/maintainer/contributor/chris`, {
        signal: AbortSignal.timeout(1_000),
      });
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), {
        error: 'dashboard route failed',
        kind: 'internal',
        details: { name: 'Error' },
      });
    } finally {
      await close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
