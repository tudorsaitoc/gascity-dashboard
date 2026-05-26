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
            const turn = parseStreamTurn(event.data);
            if (!turn) return;
            setState((current) => {
              const base = current.result ?? result;
              return {
                result: {
                  ...base,
                  turns: [...base.turns, turn],
                  total_chars: base.total_chars + turn.text.length,
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

function parseStreamTurn(data: string): TranscriptTurn | null {
  // Fail closed on anything that isn't a well-formed turn frame. A non-JSON
  // payload (e.g. an upstream "[DONE]"/keepalive sentinel) must NOT be rendered
  // as assistant transcript text — drop it rather than fabricate a turn.
  let parsed: Partial<TranscriptTurn>;
  try {
    parsed = JSON.parse(data) as Partial<TranscriptTurn>;
  } catch {
    return null;
  }
  if (typeof parsed.text !== 'string') return null;
  return {
    role: typeof parsed.role === 'string' ? parsed.role : 'assistant',
    text: parsed.text,
  };
}
