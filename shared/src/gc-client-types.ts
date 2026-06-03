// gc-supervisor wire shapes that BackendModule descriptors are contractually
// allowed to consume via `CityContext.gc` (see `shared/src/views.ts`).
//
// 9yj.1.1: extracted from `shared/src/index.ts` to break a type-only cycle
// (`views.ts` imports from `index.ts`, `index.ts` re-exports `views.ts`).
// TypeScript and bundlers tolerate type-only cycles, but the architecture
// is fragile — every new export added to the barrel risks a new edge.
// This file holds the gc-client subset views.ts depends on; index.ts
// re-exports them so external consumers (`gas-city-dashboard-shared`) see
// no API change.
//
// This file MUST NOT import from `./index.js`. Doing so would re-introduce
// the cycle this file exists to prevent. Keep it as a leaf node in the
// module graph.

import type { GcCountedList } from './lists.js';

export type IsoTimestamp = string;
export type SessionId = string;

export type GcSessionState =
  | 'creating'
  | 'active'
  | 'asleep'
  | 'detached'
  | 'failed'
  | 'closed'
  | string;

export interface GcSession {
  id: SessionId;
  template: string;
  /** Supervisor's tmux/screen session name on disk. Required per OpenAPI
   *  SessionResponse; present in 73/73 live sessions. */
  session_name: string;
  /** Required per OpenAPI SessionResponse; present in 73/73 live sessions. */
  title: string;
  alias?: string;
  state: GcSessionState;
  /** Set when state transition has a structured reason (e.g. "city-stop"). */
  reason?: string;
  /** Human-readable display name from the provider (e.g. "Claude Code"). */
  display_name?: string;
  created_at: IsoTimestamp;
  /** Last time the session emitted activity; only set after first activity. */
  last_active?: IsoTimestamp;
  /** Whether a human is currently attached to the tmux session. */
  attached: boolean;
  rig?: string;
  pool?: string;
  agent_kind?: 'pool' | 'role' | string;
  /** Process-running state independent of session.state (which is gc-level).
   *  Required per OpenAPI SessionResponse; present in 73/73 live sessions. */
  running: boolean;
  model?: string;
  context_pct?: number;
  context_window?: number;
  /** Coarse activity hint: 'idle' | 'thinking' | 'tool_use' | ... */
  activity?: string;
  /** Session provider (e.g. 'codex', 'claude', 'gemini'). Required per
   *  OpenAPI SessionResponse; present in 73/73 live sessions. */
  provider: string;
}

export type GcSessionList = GcCountedList<GcSession>;
