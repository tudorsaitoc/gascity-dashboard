import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Response } from 'express';
import { MaintainerSseHub } from '../src/maintainer/sse.js';

describe('MaintainerSseHub', () => {
  test('owns connected clients per hub instance', () => {
    const firstHub = new MaintainerSseHub();
    const secondHub = new MaintainerSseHub();
    const firstClient = new FakeSseResponse();
    const secondClient = new FakeSseResponse();

    firstHub.addClient(firstClient.asResponse());
    secondHub.addClient(secondClient.asResponse());

    firstHub.notifyRefresh({
      computed_at: '2026-05-28T00:00:00.000Z',
      repo: 'sjarmak/gascity-dashboard',
    });

    assert.equal(firstHub.clientCount, 1);
    assert.equal(secondHub.clientCount, 1);
    assert.match(firstClient.body(), /event: refreshed/);
    assert.doesNotMatch(secondClient.body(), /event: refreshed/);
  });

  test('drops a stale client after a failed heartbeat write', () => {
    const hub = new MaintainerSseHub();
    const client = new FakeSseResponse();
    hub.addClient(client.asResponse());

    client.failWrites = true;
    hub.sendHeartbeat();
    client.failWrites = false;
    hub.notifyRefresh({
      computed_at: null,
      repo: 'sjarmak/gascity-dashboard',
    });

    assert.equal(hub.clientCount, 0);
    assert.doesNotMatch(client.body(), /event: refreshed/);
  });
});

class FakeSseResponse {
  readonly headers = new Map<string, string>();
  readonly writes: string[] = [];
  failWrites = false;

  asResponse(): Response {
    return this as unknown as Response;
  }

  setHeader(name: string, value: string): this {
    this.headers.set(name, value);
    return this;
  }

  flushHeaders(): void {}

  write(chunk: string): boolean {
    if (this.failWrites) throw new Error('stale connection');
    this.writes.push(chunk);
    return true;
  }

  body(): string {
    return this.writes.join('');
  }
}
