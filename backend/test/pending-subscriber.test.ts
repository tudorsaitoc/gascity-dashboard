import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { PendingInteraction } from 'gas-city-dashboard-shared';

import { createSupervisorPendingSubscriber } from '../src/snapshot/pending-subscriber.js';
import type { SessionPendingHandlers } from '../src/snapshot/pending-subscriptions.js';

// Real fetch->SSE-parse subscriber (gascity-dashboard-3rm7, Layer 2b), driven
// by a scripted ReadableStream so the read loop + resume are deterministic.

function streamOf(chunks: string[], opts: { error?: Error } = {}): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      if (opts.error) controller.error(opts.error);
      else controller.close();
    },
  });
}

function collector(): {
  handlers: SessionPendingHandlers;
  pendings: (PendingInteraction | null)[];
  errors: Error[];
} {
  const pendings: (PendingInteraction | null)[] = [];
  const errors: Error[] = [];
  return {
    pendings,
    errors,
    handlers: { onPending: (p) => pendings.push(p), onError: (e) => errors.push(e) },
  };
}

async function settle(predicate: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries && !predicate(); i += 1) {
    await new Promise((r) => setTimeout(r, 1));
  }
}

const streamUrl = (sessionId: string, after?: string): URL =>
  new URL(`http://gc.local/session/${sessionId}/stream${after ? `?after=${after}` : ''}`);

describe('createSupervisorPendingSubscriber', () => {
  test('surfaces a valid pending frame as a PendingInteraction', async () => {
    const c = collector();
    const fetchFn = (async () =>
      new Response(streamOf(['event: pending\ndata: {"request_id":"r1","kind":"tool_approval"}\n\n']), {
        status: 200,
      })) as unknown as typeof fetch;

    const sub = createSupervisorPendingSubscriber({ streamUrl, fetchFn });
    sub.subscribe('s1', c.handlers);
    await settle(() => c.pendings.length > 0);
    assert.equal(c.pendings.length, 1);
    assert.equal(c.pendings[0]!.request_id, 'r1');
  });

  test('ignores a malformed pending frame (does not clear)', async () => {
    const c = collector();
    const fetchFn = (async () =>
      new Response(streamOf(['event: pending\ndata: {not json}\n\n']), { status: 200 })) as unknown as typeof fetch;

    createSupervisorPendingSubscriber({ streamUrl, fetchFn }).subscribe('s1', c.handlers);
    await settle(() => c.errors.length > 0); // stream then closes -> onError
    assert.equal(c.pendings.length, 0); // never surfaced, never cleared
  });

  test('a stream close surfaces onError so the manager reconnects', async () => {
    const c = collector();
    const fetchFn = (async () => new Response(streamOf([]), { status: 200 })) as unknown as typeof fetch;
    createSupervisorPendingSubscriber({ streamUrl, fetchFn }).subscribe('s1', c.handlers);
    await settle(() => c.errors.length > 0);
    assert.match(c.errors[0]!.message, /closed/);
  });

  test('a non-ok response surfaces onError', async () => {
    const c = collector();
    const fetchFn = (async () => new Response('nope', { status: 502 })) as unknown as typeof fetch;
    createSupervisorPendingSubscriber({ streamUrl, fetchFn }).subscribe('s1', c.handlers);
    await settle(() => c.errors.length > 0);
    assert.match(c.errors[0]!.message, /502/);
  });

  test('resumes from the last-event-id on the next subscribe', async () => {
    const c = collector();
    const afters: (string | undefined)[] = [];
    const trackingUrl = (sessionId: string, after?: string): URL => {
      afters.push(after);
      return streamUrl(sessionId, after);
    };
    const fetchFn = (async () =>
      new Response(streamOf(['id: 42\nevent: pending\ndata: {"request_id":"r1","kind":"k"}\n\n']), {
        status: 200,
      })) as unknown as typeof fetch;

    const subscriber = createSupervisorPendingSubscriber({ streamUrl: trackingUrl, fetchFn });
    subscriber.subscribe('s1', c.handlers);
    await settle(() => c.errors.length > 0); // first connection ends
    subscriber.subscribe('s1', collector().handlers); // manager reconnect
    await settle(() => afters.length >= 2);
    assert.equal(afters[0], undefined); // first connect: no resume
    assert.equal(afters[1], '42'); // reconnect resumes from last id
  });

  test('close() before completion suppresses onError', async () => {
    const c = collector();
    // A never-ending stream: stays open until aborted.
    const fetchFn = (async (_url: string, init?: { signal?: AbortSignal }) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            try { controller.error(new Error('aborted')); } catch { /* already closed */ }
          });
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;

    const handle = createSupervisorPendingSubscriber({ streamUrl, fetchFn }).subscribe('s1', c.handlers);
    await new Promise((r) => setTimeout(r, 2));
    handle.close();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(c.errors.length, 0); // close is not a failure
  });
});
