import { useEffect, useState } from 'react';
import type { TranscriptResult, TranscriptTurn } from 'gas-city-dashboard-shared';
import { api } from '../api/client';

interface SessionStreamState {
  result: TranscriptResult | null;
  loading: boolean;
  error: string | null;
  streamState: SessionStreamConnState;
}

export type SessionStreamConnState = 'idle' | 'connecting' | 'open' | 'closed';

export function useSessionStream(
  sessionId: string | null,
  stream: boolean,
): SessionStreamState {
  const [state, setState] = useState<SessionStreamState>({
    result: null,
    loading: false,
    error: null,
    streamState: 'idle',
  });

  useEffect(() => {
    if (!sessionId) {
      setState({ result: null, loading: false, error: null, streamState: 'idle' });
      return;
    }
    let cancelled = false;
    let source: EventSource | null = null;
    const canStream = stream && typeof EventSource !== 'undefined';
    setState({
      result: null,
      loading: true,
      error: null,
      streamState: canStream ? 'connecting' : 'idle',
    });

    api.peekSession(sessionId).then(
      (result) => {
        if (cancelled) return;
        setState({
          result,
          loading: false,
          error: null,
          streamState: canStream ? 'connecting' : 'idle',
        });
        if (canStream) {
          source = new EventSource(api.sessionStreamUrl(sessionId), {
            withCredentials: true,
          });
          source.onopen = () => {
            if (cancelled) return;
            setState((current) => ({ ...current, streamState: 'open' }));
          };
          const onTurn = (event: MessageEvent<string>) => {
            if (cancelled) return;
            const payload = parseStreamPayload(event.data);
            if (!payload) return;
            setState((current) => {
              const base = current.result ?? result;
              if (payload.kind === 'snapshot') {
                return {
                  result: payload.result,
                  loading: false,
                  error: null,
                  streamState: 'open',
                };
              }
              return {
                result: {
                  ...base,
                  turns: [...base.turns, payload.turn],
                  total_chars: base.total_chars + payload.turn.text.length,
                  captured_at: new Date().toISOString(),
                },
                loading: false,
                error: null,
                streamState: 'open',
              };
            });
          };
          source.onmessage = onTurn;
          source.addEventListener('turn', onTurn);
          source.onerror = () => {
            if (cancelled) return;
            const streamState =
              source?.readyState === EventSource.CLOSED ? 'closed' : 'connecting';
            setState((current) => ({ ...current, streamState }));
          };
        }
      },
      (err: unknown) => {
        if (!cancelled) {
          setState({
            result: null,
            loading: false,
            error: err instanceof Error ? err.message : 'Failed to load session.',
            streamState: 'idle',
          });
        }
      },
    );

    return () => {
      cancelled = true;
      source?.close();
    };
  }, [sessionId, stream]);

  return state;
}

type SessionStreamPayload =
  | { kind: 'turn'; turn: TranscriptTurn }
  | { kind: 'snapshot'; result: TranscriptResult };

function parseStreamPayload(data: string): SessionStreamPayload | null {
  // Fail closed on anything that isn't a well-formed turn frame. A non-JSON
  // payload (e.g. an upstream "[DONE]"/keepalive sentinel) must NOT be rendered
  // as assistant transcript text — drop it rather than fabricate a turn.
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const snapshot = parseTranscriptSnapshot(parsed);
  if (snapshot) return { kind: 'snapshot', result: snapshot };
  if (typeof parsed.text !== 'string') return null;
  return {
    kind: 'turn',
    turn: {
      role: typeof parsed.role === 'string' ? parsed.role : 'assistant',
      text: parsed.text,
    },
  };
}

function parseTranscriptSnapshot(value: Record<string, unknown>): TranscriptResult | null {
  if (!Array.isArray(value.turns)) return null;
  const turns = value.turns.flatMap((turn): TranscriptTurn[] => {
    if (!isRecord(turn) || typeof turn.text !== 'string') return [];
    return [{
      role: typeof turn.role === 'string' ? turn.role : 'assistant',
      text: turn.text,
    }];
  });
  if (turns.length !== value.turns.length) return null;
  const sessionId = typeof value.session_id === 'string'
    ? value.session_id
    : typeof value.id === 'string'
      ? value.id
      : '';
  if (!sessionId) return null;
  const totalChars = typeof value.total_chars === 'number'
    ? value.total_chars
    : turns.reduce((sum, turn) => sum + turn.text.length, 0);
  return {
    session_id: sessionId,
    template: typeof value.template === 'string' ? value.template : undefined,
    provider: typeof value.provider === 'string' ? value.provider : undefined,
    format: typeof value.format === 'string' ? value.format : 'conversation',
    turns,
    total_chars: totalChars,
    captured_at: typeof value.captured_at === 'string'
      ? value.captured_at
      : new Date().toISOString(),
    truncated: value.truncated === true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
