import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GcSession, TranscriptResult } from 'gas-city-dashboard-shared';
import {
  LiveSessionPeek,
  isSessionStreamable,
  streamBadge,
} from './LiveSessionPeek';

// ── Minimal FakeEventSource (mirrors the pattern in WorkflowRunDetail.test) ──
const eventSources: FakeEventSource[] = [];

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = FakeEventSource.CONNECTING;
  readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();

  constructor(readonly url: string) {
    eventSources.push(this);
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.(new Event('open'));
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== listener),
    );
  }

  dispatch(type: string, payload: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(payload) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const snapshot: TranscriptResult = {
  session_id: 's1',
  turns: [{ role: 'assistant', text: 'snapshot turn body' }],
  total_chars: 18,
  captured_at: '2026-05-27T00:00:00Z',
  truncated: false,
};

function session(overrides: Partial<GcSession>): GcSession {
  return { id: 's1', state: 'active', ...overrides } as GcSession;
}

describe('streamBadge', () => {
  it('maps each connection state to a tone + label', () => {
    expect(streamBadge('open')).toEqual({ tone: 'ok', label: 'live' });
    expect(streamBadge('connecting')).toEqual({ tone: 'warn', label: 'connecting' });
    expect(streamBadge('closed')).toEqual({ tone: 'stuck', label: 'offline' });
    expect(streamBadge('idle')).toEqual({ tone: 'neutral', label: 'snapshot' });
  });
});

describe('isSessionStreamable', () => {
  it('is false for null', () => {
    expect(isSessionStreamable(null)).toBe(false);
  });
  it('is true when the process is running', () => {
    expect(isSessionStreamable(session({ state: 'asleep', running: true }))).toBe(true);
  });
  it('is true when the gc state is active', () => {
    expect(isSessionStreamable(session({ state: 'active', running: false }))).toBe(true);
  });
  it("is true when the gc state is 'running' (aligns with SESSION_CHIPS)", () => {
    expect(isSessionStreamable(session({ state: 'running', running: false }))).toBe(true);
  });
  it('is false for a non-running, non-active session', () => {
    expect(isSessionStreamable(session({ state: 'asleep', running: false }))).toBe(false);
  });
});

describe('LiveSessionPeek (streaming)', () => {
  beforeEach(() => {
    eventSources.length = 0;
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === '/api/sessions/s1/peek') return jsonResponse(snapshot);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the snapshot, then a live turn appended over the stream, with a live badge', async () => {
    render(<LiveSessionPeek sessionId="s1" stream showBadge showCaption />);

    // Snapshot fetched and rendered.
    expect(await screen.findByText('snapshot turn body')).toBeTruthy();
    // While the stream opens, the badge reads "connecting".
    expect(screen.getByText('connecting')).toBeTruthy();

    // Open the stream -> badge flips to "live".
    const es = eventSources[0];
    expect(es).toBeDefined();
    act(() => es!.open());
    expect(await screen.findByText('live')).toBeTruthy();

    // A streamed 'turn' event appends without replacing the snapshot.
    act(() => es!.dispatch('turn', { role: 'assistant', text: 'streamed turn body' }));
    expect(await screen.findByText('streamed turn body')).toBeTruthy();
    expect(screen.getByText('snapshot turn body')).toBeTruthy();
  });

  it('shows a snapshot badge and opens no EventSource when stream is false', async () => {
    render(<LiveSessionPeek sessionId="s1" stream={false} showBadge showCaption />);
    expect(await screen.findByText('snapshot turn body')).toBeTruthy();
    expect(screen.getByText('snapshot')).toBeTruthy();
    expect(eventSources).toHaveLength(0);
  });
});
