import { describe, test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';

import { proxySupervisorSse } from '../src/routes/sse-proxy.js';

// gascity-dashboard-6taa: the drain-vs-close race in proxySupervisorSse.
//
// When a client reads slowly, res.write() returns false (backpressure) and the
// proxy parks on a Promise that resolves on EITHER 'drain' OR 'close'. If the
// client disconnects *during* that backpressured write, only the 'close'
// listener can release the parked await — without it the await orphans forever,
// leaking the upstream connection and the heartbeat timer. These tests drive
// that exact path with fakes: a regression makes the proxy promise never
// resolve, which the per-test deadline turns into an explicit failure instead
// of a hung suite.

interface FakeReq extends EventEmitter {
  headers: Record<string, string>;
  query: Record<string, string>;
}

function fakeReq(): FakeReq {
  const req = new EventEmitter() as FakeReq;
  req.headers = {};
  req.query = {};
  return req;
}

interface FakeRes extends EventEmitter {
  headersSent: boolean;
  writableEnded: boolean;
  destroyed: boolean;
  statusCode: number;
  /** When false, the next write() reports backpressure (returns false). */
  acceptWrites: boolean;
  writes: string[];
  status(code: number): FakeRes;
  setHeader(name: string, value: string): void;
  flushHeaders(): void;
  write(chunk: string | Uint8Array): boolean;
  end(): void;
  json(body: unknown): void;
}

function fakeRes(): FakeRes {
  const res = new EventEmitter() as FakeRes;
  res.headersSent = false;
  res.writableEnded = false;
  res.destroyed = false;
  res.statusCode = 0;
  res.acceptWrites = true;
  res.writes = [];
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.setHeader = () => undefined;
  res.flushHeaders = () => {
    res.headersSent = true;
  };
  res.write = (chunk: string | Uint8Array) => {
    res.writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return res.acceptWrites;
  };
  res.end = () => {
    res.writableEnded = true;
  };
  res.json = () => {
    res.writableEnded = true;
  };
  return res;
}

/** A ReadableStream-backed upstream body whose chunks are pushed by the test. */
function makeUpstream(): {
  upstream: globalThis.Response;
  push: (text: string) => void;
  closeUpstream: () => void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    upstream: { ok: true, status: 200, body } as unknown as globalThis.Response,
    push: (text: string) => controller?.enqueue(new TextEncoder().encode(text)),
    closeUpstream: () => controller?.close(),
  };
}

const OPTS = {
  // `fetch` is stubbed, so the upstream URL is never dialed — it only satisfies
  // the option contract.
  upstream: new URL('http://127.0.0.1/unused'),
  // A finite heartbeat that never fires inside the test window, yet is cleared
  // by the proxy's finally block so it cannot keep the event loop alive.
  heartbeatMs: 1_000_000,
  unreachableMessage: 'unreachable',
  noBodyMessage: 'no body',
};

/** Reject if the proxy promise has not settled within `ms` (regression guard). */
function withDeadline(p: Promise<void>, ms: number): Promise<void> {
  return Promise.race([
    p,
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error('proxySupervisorSse never resolved (parked await leaked)')), ms),
    ),
  ]);
}

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('proxySupervisorSse drain-vs-close race', () => {
  let restoreFetch: (() => void) | undefined;

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
  });

  function stubFetch(upstream: globalThis.Response): void {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => upstream) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = real;
    };
  }

  test('a client disconnect during a backpressured write releases the parked await', async () => {
    const req = fakeReq();
    const res = fakeRes();
    const { upstream, push } = makeUpstream();
    stubFetch(upstream);

    const done = proxySupervisorSse(
      req as unknown as Request,
      res as unknown as Response,
      OPTS,
    );

    // First chunk: the client refuses further writes, so the proxy parks on the
    // drain/close Promise.
    res.acceptWrites = false;
    push('event: event\ndata: {"type":"a"}\n\n');
    await settle();
    assert.equal(res.writes.length, 1, 'the backpressured chunk should have been written once');
    assert.equal(res.writableEnded, false, 'proxy should still be parked, not ended');

    // The client disconnects mid-write. Only the 'close' listener can resolve
    // the parked await; the matching req 'close' aborts the upstream.
    res.destroyed = true;
    res.emit('close');
    req.emit('close');

    await withDeadline(done, 2_000);
    assert.equal(res.writableEnded, true, 'proxy finally block ended the client stream');
  });

  test('a drain event releases the parked await and writing resumes', async () => {
    const req = fakeReq();
    const res = fakeRes();
    const { upstream, push, closeUpstream } = makeUpstream();
    stubFetch(upstream);

    const done = proxySupervisorSse(
      req as unknown as Request,
      res as unknown as Response,
      OPTS,
    );

    res.acceptWrites = false;
    push('event: event\ndata: {"type":"a"}\n\n');
    await settle();
    assert.equal(res.writes.length, 1);

    // The client catches up: 'drain' releases the await and the loop reads
    // again. A second chunk lands now that writes are accepted.
    res.acceptWrites = true;
    res.emit('drain');
    await settle();
    push('event: event\ndata: {"type":"b"}\n\n');
    await settle();
    assert.equal(res.writes.length, 2, 'writing resumed after drain');

    // Upstream ends the stream normally; the proxy's read loop sees `done` and
    // runs its finally block.
    closeUpstream();
    await withDeadline(done, 2_000);
    assert.equal(res.writableEnded, true);
  });
});
