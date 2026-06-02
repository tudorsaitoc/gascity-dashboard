// Real SessionStreamSubscriber (gascity-dashboard-3rm7, Layer 2b): opens the
// supervisor's per-session text/event-stream, parses frames, and surfaces
// `pending` events as PendingInteractions to the PendingSubscriptionManager.
//
// fetch is injected so the read loop is unit-tested with a scripted
// ReadableStream. Resume is supported via a per-session last-event-id passed
// back into the stream URL on the manager's reconnect.

import { parsePendingInteraction } from 'gas-city-dashboard-shared';

import { SseFrameParser } from './sse-frame-parser.js';
import type {
  SessionPendingHandlers,
  SessionStreamSubscriber,
  SessionStreamSubscription,
} from './pending-subscriptions.js';

export interface SupervisorPendingSubscriberDeps {
  /** Build the per-session stream URL, optionally resuming from a last-event-id. */
  streamUrl: (sessionId: string, after?: string) => URL;
  /** Injected for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
}

function safeJsonParse(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

export function createSupervisorPendingSubscriber(
  deps: SupervisorPendingSubscriberDeps,
): SessionStreamSubscriber {
  const fetchFn = deps.fetchFn ?? fetch;
  const lastEventId = new Map<string, string>();

  return {
    subscribe(sessionId: string, handlers: SessionPendingHandlers): SessionStreamSubscription {
      const ctrl = new AbortController();
      let closed = false;

      const fail = (err: unknown): void => {
        if (closed || ctrl.signal.aborted) return; // close() is not a failure
        handlers.onError(err instanceof Error ? err : new Error(String(err)));
      };

      void (async () => {
        let res: Response;
        try {
          res = await fetchFn(deps.streamUrl(sessionId, lastEventId.get(sessionId)).toString(), {
            signal: ctrl.signal,
            headers: { accept: 'text/event-stream' },
          });
        } catch (err) {
          fail(err);
          return;
        }

        if (!res.ok || res.body === null) {
          fail(new Error(`session stream responded ${res.status}`));
          return;
        }

        const parser = new SseFrameParser();
        const decoder = new TextDecoder();
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
              if (ev.id !== undefined) lastEventId.set(sessionId, ev.id);
              if (ev.event !== 'pending') continue;
              const pending = parsePendingInteraction(safeJsonParse(ev.data));
              // Surface only a valid interaction. A malformed `pending` frame is
              // ignored (NOT treated as a clear), so a parse hiccup cannot wipe a
              // real pending. Explicit-clear semantics are unconfirmed upstream;
              // the manager also clears via retainActive on session inactivity.
              if (pending !== null) handlers.onPending(pending);
            }
          }
          // The supervisor holds the stream open; a normal end means the
          // connection dropped — surface it so the manager reconnects.
          fail(new Error('session stream closed'));
        } catch (err) {
          fail(err);
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // reader already released on abort; nothing to do.
          }
        }
      })();

      return {
        close(): void {
          closed = true;
          ctrl.abort();
        },
      };
    },
  };
}
