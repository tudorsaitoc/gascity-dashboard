// Package root barrel for dashboard-owned /api DTOs and shared helpers.
// Keep runtime helper exports as value exports; type-only domain leaves use
// `export type *` so importing the package root does not pull in dead JS.

export type * from './snapshot/types.js';
export {
  resolveSessionForTarget,
  matchesSessionTarget,
  lastSegment,
} from './session-resolve.js';
export * from './run-detail.js';
export type * from './run-snapshot.js';
export * from './links.js';
export * from './city.js';
export * from './operator.js';
export * from './alert.js';
export * from './context-window.js';
export type * from './lists.js';
export type * from './transcript.js';
export type * from './gc-agents.js';
export type * from './gc-rigs.js';
export type * from './gc-beads.js';
export type * from './gc-mail.js';
export type * from './gc-health.js';
export type * from './gc-events.js';
export type * from './formula-runs.js';
export type * from './api-error.js';
export type * from './maintainer-triage.js';
export type * from './views.js';
export type * from './gc-client-types.js';
