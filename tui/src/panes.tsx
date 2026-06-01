import React from 'react';
import { Box, Text } from 'ink';
import type { RunLane } from 'gas-city-dashboard-shared';
import type { GcBead } from './api.ts';
import {
  ctxPct,
  laneNeedsOperator,
  laneRig,
  peekCommands,
  relativeTime,
  shortModel,
  type AgentView,
  type ContextPressureEntry,
  type IdleRollup,
  type SystemHealth,
} from './derive.ts';

function pct(n: number | null | undefined, scale01 = false): string {
  if (n === null || n === undefined) return '—';
  return `${Math.round(scale01 ? n * 100 : n)}%`;
}

// ── one agent row in the list ───────────────────────────────────────────────

interface AgentRowProps {
  readonly view: AgentView;
  readonly selected: boolean;
  readonly dim: boolean;
  readonly now: number;
}

export function AgentRow({ view, selected, dim, now }: AgentRowProps): React.JSX.Element {
  const s = view.session;
  const pct = ctxPct(s);
  const ctx = pct !== undefined ? `${pct}%` : '';
  // Active agents show live activity; dormant agents show WHY they're idle
  // (the supervisor's transition reason, e.g. "city-stop"/"drained") rather
  // than a bare "asleep", so "I thought we suspended that" is answerable.
  const activity =
    view.category === 'active'
      ? (s.activity ?? '')
      : s.attached
        ? 'attached'
        : (s.reason ?? s.state);
  return (
    <Box>
      <Box width={2}>
        {selected ? <Text color="cyan">▸</Text> : <Text> </Text>}
      </Box>
      <Box width={40} marginRight={2}>
        <Text wrap="truncate-end" bold={selected} inverse={selected} dimColor={dim && !selected}>
          {view.agent}
        </Text>
      </Box>
      <Box width={4} marginRight={1} justifyContent="flex-end">
        <Text dimColor>{ctx}</Text>
      </Box>
      <Box width={9} marginRight={1}>
        <Text wrap="truncate-end" dimColor>
          {activity}
        </Text>
      </Box>
      <Box width={10} marginRight={1}>
        <Text wrap="truncate-end" dimColor>
          {shortModel(s.model) || s.provider}
        </Text>
      </Box>
      <Box width={5} justifyContent="flex-end">
        <Text dimColor>{relativeTime(s.last_active, now)}</Text>
      </Box>
    </Box>
  );
}

// ── one bead row (beads view) ───────────────────────────────────────────────

interface BeadRowProps {
  readonly bead: GcBead;
  readonly selected: boolean;
  readonly dim: boolean;
}

export function BeadRow({ bead, selected, dim }: BeadRowProps): React.JSX.Element {
  const prio = typeof bead.priority === 'number' ? `P${bead.priority}` : '';
  return (
    <Box>
      <Box width={2}>{selected ? <Text color="cyan">▸</Text> : <Text> </Text>}</Box>
      <Box width={3} marginRight={1}>
        <Text dimColor>{prio}</Text>
      </Box>
      <Box flexGrow={1} marginRight={1}>
        <Text wrap="truncate-end" bold={selected} inverse={selected} dimColor={dim && !selected}>
          {bead.title}
        </Text>
      </Box>
      <Box width={8} marginRight={1}>
        <Text wrap="truncate-end" dimColor>
          {bead.issue_type}
        </Text>
      </Box>
    </Box>
  );
}

// ── one run-lane row (formula runs view) ─────────────────────────────────────

interface RunRowProps {
  readonly lane: RunLane;
  readonly selected: boolean;
}

export function RunRow({ lane, selected }: RunRowProps): React.JSX.Element {
  const needsOp = laneNeedsOperator(lane);
  return (
    <Box>
      <Box width={2}>
        {needsOp ? <Text color="red">●</Text> : selected ? <Text color="cyan">▸</Text> : <Text> </Text>}
      </Box>
      <Box flexGrow={1} marginRight={1}>
        <Text wrap="truncate-end" bold={selected} inverse={selected}>
          {lane.title}
        </Text>
      </Box>
      <Box width={14} marginRight={1}>
        <Text wrap="truncate-end" dimColor>
          {lane.phaseLabel}
        </Text>
      </Box>
      <Box width={12}>
        <Text wrap="truncate-end" dimColor>
          {needsOp ? 'needs operator' : ''}
        </Text>
      </Box>
    </Box>
  );
}

// ── detail / peek pane for the selected agent ───────────────────────────────

interface DetailPaneProps {
  readonly view: AgentView;
  readonly beads: readonly GcBead[];
  readonly lanes: readonly RunLane[];
  readonly now: number;
}

export function DetailPane({ view, beads, lanes, now }: DetailPaneProps): React.JSX.Element {
  const s = view.session;
  const cmds = peekCommands(s);
  const pct = ctxPct(s);
  const ctx = pct !== undefined ? `${pct}%` : '—';
  return (
    <Box flexDirection="column">
      <Text bold>
        {view.rig} · {view.agent}
      </Text>
      <Text dimColor>
        {s.state}
        {s.reason ? ` (${s.reason})` : ''} · {s.provider}
        {s.model ? ` · ${shortModel(s.model)}` : ''} · ctx {ctx} · last {relativeTime(s.last_active, now)}
        {s.attached ? ' · attached' : ''}
      </Text>
      <Text dimColor>
        id {s.id} · pool {s.pool ?? '—'} · kind {s.agent_kind ?? '—'}
      </Text>

      <Box marginTop={1}>
        <Text bold>peek</Text>
      </Box>
      <Text>  {cmds.gcPeek}</Text>
      <Text>  {cmds.tmuxAttach}</Text>
      <Text dimColor>  {cmds.tmuxCapture}</Text>

      <Box marginTop={1}>
        <Text bold>formulas </Text>
        <Text dimColor>(active run lanes on this rig)</Text>
      </Box>
      {lanes.length === 0 ? (
        <Text dimColor>  none</Text>
      ) : (
        lanes.slice(0, 6).map((l) => (
          <Box key={l.id}>
            <Text>  {laneNeedsOperator(l) ? <Text color="red">● </Text> : '  '}</Text>
            <Text>{l.title}</Text>
            <Text dimColor> — {l.phaseLabel}</Text>
            {laneNeedsOperator(l) ? <Text color="red"> — needs operator</Text> : null}
          </Box>
        ))
      )}

      <Box marginTop={1}>
        <Text bold>beads </Text>
        <Text dimColor>(this rig, best-effort match)</Text>
      </Box>
      {beads.length === 0 ? (
        <Text dimColor>  none</Text>
      ) : (
        beads.slice(0, 8).map((b) => (
          <Box key={b.id}>
            <Text dimColor>  [{b.status}] </Text>
            <Text wrap="truncate-end">{b.title}</Text>
          </Box>
        ))
      )}

      <Box marginTop={1}>
        <Text dimColor>↑↓ change agent · enter peek · x close peek · p close · q quit</Text>
      </Box>
    </Box>
  );
}

// ── system health / observability pane ──────────────────────────────────────

interface HealthPaneProps {
  readonly health: SystemHealth;
  readonly idle: readonly IdleRollup[];
  readonly pressure: readonly ContextPressureEntry[];
  readonly now: number;
}

export function HealthPane({ health, idle, pressure }: HealthPaneProps): React.JSX.Element {
  const needsOp = health.lanes.filter(laneNeedsOperator);
  return (
    <Box flexDirection="column">
      <Text bold>system</Text>
      <Text dimColor>
        {'  '}load {health.load1?.toFixed(2) ?? '—'} / {health.vcpu ?? '—'} vcpu (
        {health.loadPerVcpu?.toFixed(2) ?? '—'} per-vcpu) · mem {pct(health.memUtil, true)}
      </Text>
      <Text dimColor>
        {'  '}agents {health.activeAgents ?? '—'} active · sessions {health.activeSessions ?? '—'} · runs{' '}
        {health.activeRuns ?? '—'} active · max {health.maxAgents ?? '—'}
      </Text>

      <Box marginTop={1}>
        <Text bold>runs needing operator </Text>
        <Text dimColor>({needsOp.length})</Text>
      </Box>
      {needsOp.length === 0 ? (
        <Text dimColor>  none</Text>
      ) : (
        needsOp.slice(0, 8).map((l) => (
          <Box key={l.id}>
            <Text color="red">  ● </Text>
            <Text>{l.title}</Text>
            <Text dimColor>
              {' '}({laneRig(l) ?? '—'}) — {l.phaseLabel}
            </Text>
          </Box>
        ))
      )}

      <Box marginTop={1}>
        <Text bold>context pressure </Text>
        <Text dimColor>(≥75%)</Text>
      </Box>
      {pressure.length === 0 ? (
        <Text dimColor>  none</Text>
      ) : (
        pressure.slice(0, 8).map((e) => (
          <Box key={e.session.id}>
            <Text color="red">  {e.pct}% </Text>
            <Text wrap="truncate-end">{e.session.title}</Text>
          </Box>
        ))
      )}

      <Box marginTop={1}>
        <Text bold>idle / reallocation </Text>
        <Text dimColor>(agents never active, by rig)</Text>
      </Box>
      {idle.length === 0 ? (
        <Text dimColor>  none</Text>
      ) : (
        idle.slice(0, 10).map((r) => (
          <Box key={r.rig}>
            <Text dimColor>{'  '}</Text>
            <Text>{r.rig}</Text>
            <Text dimColor>
              {'  '}
              {r.neverActive} never / {r.total}
            </Text>
          </Box>
        ))
      )}

      <Box marginTop={1}>
        <Text bold>costs</Text>
      </Box>
      <Text dimColor>
        {'  '}not measured — supervisor exposes no per-run cost yet
      </Text>
      <Text dimColor>  (see specs/architecture/cost-token-feasibility.md)</Text>

      <Box marginTop={1}>
        <Text dimColor>h close · q quit</Text>
      </Box>
    </Box>
  );
}
