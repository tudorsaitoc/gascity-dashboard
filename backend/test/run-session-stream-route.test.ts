import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { GcClient } from '../src/gc-client.js';
import { sessionStreamRouter } from '../src/routes/session-stream.js';

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void;

interface FakeSupervisor {
  baseUrl: string;
  requests: string[];
  setHandler(h: Handler): void;
  liveConnections(): number;
  close(): Promise<void>;
}

describe('session stream route', () => {
  let fake: FakeSupervisor;

  beforeEach(async () => {
    fake = await startFakeSupervisor();
  });

  afterEach(async () => {
    await fake.close();
  });

  test('proxies supervisor session SSE and forwards Last-Event-ID', async () => {
    fake.setHandler((req, res) => {
      assert.equal(req.url, '/v0/city/racoon-city/session/gc-session-b/stream?after=41');
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.end('id: 42\nevent: turn\ndata: {"role":"assistant","text":"still working"}\n\n');
    });
    const { url, close } = await startApp(buildApp(fake.baseUrl));
    try {
      const res = await fetch(`${url}/api/sessions/gc-session-b/stream`, {
        headers: { 'Last-Event-ID': '41' },
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
      const text = await res.text();
      assert.match(text, /event: turn/);
      assert.match(text, /still working/);
    } finally {
      await close();
    }
  });

  test('client disconnect closes the upstream supervisor session stream', async () => {
    fake.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.flushHeaders();
      res.write('event: turn\ndata: {"role":"assistant","text":"open"}\n\n');
    });
    const { url, close } = await startApp(buildApp(fake.baseUrl));
    try {
      const ctrl = new AbortController();
      const res = await fetch(`${url}/api/sessions/gc-session-b/stream`, {
        signal: ctrl.signal,
      });
      assert.equal(res.status, 200);
      assert.ok(fake.liveConnections() >= 1, 'upstream connection should be open');
      ctrl.abort();
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(
        fake.liveConnections(),
        0,
        'upstream should be closed after client disconnect',
      );
    } finally {
      await close();
    }
  });

  test('rejects invalid stream session ids before calling supervisor', async () => {
    const { url, close } = await startApp(buildApp(fake.baseUrl));
    try {
      const res = await fetch(`${url}/api/sessions/bad$id/stream`);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.kind, 'validation');
      assert.equal(fake.requests.length, 0);
    } finally {
      await close();
    }
  });
});

function buildApp(fakeUrl: string): express.Express {
  const gc = new GcClient({
    baseUrl: fakeUrl,
    cityName: 'racoon-city',
    defaultTimeoutMs: 500,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionStreamRouter({
    gc,
    heartbeatMs: 10_000,
  }));
  return app;
}

function startFakeSupervisor(): Promise<FakeSupervisor> {
  return new Promise((resolve) => {
    let handler: Handler = (_req, res) => {
      res.statusCode = 404;
      res.end('not found');
    };
    const requests: string[] = [];
    const sockets = new Set<import('node:net').Socket>();
    let live = 0;
    const server = http.createServer((req, res) => {
      requests.push(req.url ?? '');
      live += 1;
      res.on('close', () => {
        live -= 1;
      });
      handler(req, res);
    });
    server.on('connection', (sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        setHandler(h: Handler) {
          handler = h;
        },
        liveConnections() {
          return live;
        },
        close() {
          for (const sock of sockets) sock.destroy();
          return new Promise<void>((done) => server.close(() => done()));
        },
      });
    });
  });
}

function startApp(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
