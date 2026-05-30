import type { Response } from 'express';
import type { MaintainerTriage } from 'gas-city-dashboard-shared';

// Tiny in-process pub/sub for the maintainer triage view
// (gascity-dashboard-1nx). The nightly worker and the manual refresh
// handler both call notifyRefresh after rewriting the cache; every
// open EventSource on /api/maintainer/events receives a 'refreshed'
// event and the frontend refetches /triage to pick up the new state.
//
// Single-user localhost tool — no shared state across processes, no
// horizontal scale to worry about. A Set of Response objects is
// enough; on client disconnect or write failure the response gets
// dropped from the set.

// module-allow: SSE client registry is intentionally module-scoped per
// maintainer-coupling.md C1. Premortem #2's "two-Set" failure mode is
// addressed by a SINGLE canonical import path for this module after PR-B1
// — every consumer (router, worker) imports from this exact file, and
// the snap harness extends to assert SSE round-trip post-relocation.
const clients = new Set<Response>();

export function addSseClient(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Disable proxy buffering so events flush immediately.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  // Initial comment line so the browser knows the stream is alive.
  res.write(': hello\n\n');
  clients.add(res);
}

export function removeSseClient(res: Response): void {
  clients.delete(res);
}

export function notifyRefresh(meta: Pick<MaintainerTriage, 'computed_at' | 'repo'>): void {
  const payload = `event: refreshed\ndata: ${JSON.stringify({
    computed_at: meta.computed_at,
    repo: meta.repo,
  })}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      // Write to a stale connection — drop it.
      clients.delete(res);
    }
  }
}

export function sendHeartbeat(): void {
  // Comment-only line; doesn't fire client-side handlers but keeps
  // intermediaries from idling the connection out.
  for (const res of clients) {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clients.delete(res);
    }
  }
}
