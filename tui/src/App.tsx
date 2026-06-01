import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { useCity } from './useCity.ts';
import { useMouseWheel } from './useMouseWheel.ts';
import { AgentRow, BeadRow, DetailPane, HealthPane, RunRow } from './panes.tsx';
import {
  buildCommand,
  closePeek,
  openPeek,
  paneExists,
  replacePeek,
  type PeekKind,
} from './peek.ts';
import {
  beadsForRig,
  categorize,
  contextPressure,
  groupBeads,
  groupByRig,
  groupRuns,
  lanesForRig,
  laneNeedsOperator,
  neverActiveByRig,
  systemHealth,
  type AgentView,
  type Category,
} from './derive.ts';
import type { GcBead, GcSession, RunLane } from './api.ts';

interface AppProps {
  readonly baseUrl: string;
  readonly city: string;
}

type ViewMode = 'list' | 'beads' | 'runs' | 'detail' | 'health';

type Entry =
  | { readonly kind: 'agent'; readonly id: string; readonly agent: AgentView }
  | { readonly kind: 'bead'; readonly id: string; readonly bead: GcBead }
  | { readonly kind: 'run'; readonly id: string; readonly lane: RunLane };

interface GroupInfo {
  readonly label: string;
  readonly sub: string;
  readonly alert: boolean;
}

type Row =
  | { readonly kind: 'heading'; readonly group: GroupInfo }
  | {
      readonly kind: 'entry';
      readonly entry: Entry;
      readonly index: number;
      readonly dim: boolean;
      readonly group: GroupInfo;
    };

interface Nav {
  readonly entries: readonly Entry[];
  readonly renderRows: readonly Row[];
}

const EMPTY_NAV: Nav = { entries: [], renderRows: [] };

function buildNav(
  view: ViewMode,
  sessions: readonly GcSession[],
  beads: readonly GcBead[],
  lanes: readonly RunLane[],
): Nav {
  const entries: Entry[] = [];
  const renderRows: Row[] = [];
  const push = (entry: Entry, dim: boolean, group: GroupInfo): void => {
    renderRows.push({ kind: 'entry', entry, index: entries.length, dim, group });
    entries.push(entry);
  };

  if (view === 'beads') {
    for (const g of groupBeads(beads)) {
      const group: GroupInfo = { label: g.status, sub: `${g.beads.length}`, alert: false };
      renderRows.push({ kind: 'heading', group });
      const dim = g.status === 'closed' || g.status === 'deferred';
      for (const b of g.beads) push({ kind: 'bead', id: b.id, bead: b }, dim, group);
    }
    return { entries, renderRows };
  }

  if (view === 'runs') {
    for (const g of groupRuns(lanes)) {
      const needs = g.lanes.filter(laneNeedsOperator).length;
      const group: GroupInfo = {
        label: g.rig,
        sub: needs > 0 ? `${g.lanes.length} · ${needs} need operator` : `${g.lanes.length}`,
        alert: needs > 0,
      };
      renderRows.push({ kind: 'heading', group });
      for (const l of g.lanes) push({ kind: 'run', id: l.id, lane: l }, false, group);
    }
    return { entries, renderRows };
  }

  // list (and detail, which navigates the same agent list underneath)
  for (const g of groupByRig(sessions)) {
    const group: GroupInfo = {
      label: g.rig,
      sub: `${g.failed > 0 ? `${g.failed} failed · ` : ''}${g.active} active · ${g.idle} idle`,
      alert: g.failed > 0,
    };
    renderRows.push({ kind: 'heading', group });
    for (const v of g.agents) {
      push({ kind: 'agent', id: v.session.id, agent: v }, v.category === 'idle', group);
    }
  }
  return { entries, renderRows };
}

function entryLabel(e: Entry): string {
  if (e.kind === 'agent') return e.agent.agent;
  if (e.kind === 'bead') return e.bead.id;
  return e.lane.title;
}

function useTerminalRows(): number {
  const { stdout } = useStdout();
  const [rows, setRows] = useState(stdout.rows ?? 24);
  useEffect(() => {
    const onResize = (): void => setRows(stdout.rows ?? 24);
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return rows;
}

export function App({ baseUrl, city }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const { sessions, snapshot, beads, error, conn } = useCity(baseUrl, city);
  const rows = useTerminalRows();

  const [view, setView] = useState<ViewMode>('list');
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  // A single reused peek pane: its tmux id, and "<kind>:<id>" it's showing.
  const [peekPaneId, setPeekPaneId] = useState<string | null>(null);
  const [peekTarget, setPeekTarget] = useState<string | null>(null);
  const now = Date.now();

  const health = useMemo(() => systemHealth(snapshot), [snapshot]);
  // detail navigates the same agent list as 'list' underneath.
  const navView: ViewMode = view === 'detail' ? 'list' : view;
  const { entries, renderRows } = useMemo(
    () => (navView === 'health' ? EMPTY_NAV : buildNav(navView, sessions, beads, health.lanes)),
    [navView, sessions, beads, health.lanes],
  );

  const cursorIndex = Math.max(0, entries.findIndex((e) => e.id === cursorId));
  const selected: Entry | undefined = entries[cursorIndex];
  const selectedAgent: AgentView | undefined =
    selected && selected.kind === 'agent' ? selected.agent : undefined;

  // Keep the cursor on a real entry as lists churn / views switch.
  useEffect(() => {
    if (entries.length === 0) return;
    if (cursorId === null || !entries.some((e) => e.id === cursorId)) {
      setCursorId(entries[0]?.id ?? null);
    }
  }, [entries, cursorId]);

  // Refs so the wheel callback stays stable (re-subscribing re-emits the
  // mouse-enable escape sequence every render).
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const cursorIndexRef = useRef(cursorIndex);
  cursorIndexRef.current = cursorIndex;

  const moveCursor = useCallback((delta: number) => {
    const list = entriesRef.current;
    if (list.length === 0) return;
    const next = Math.min(Math.max(cursorIndexRef.current + delta, 0), list.length - 1);
    setCursorId(list[next]?.id ?? null);
  }, []);

  useMouseWheel(useCallback((dir: -1 | 1) => moveCursor(dir * 3), [moveCursor]));

  const closeActivePeek = (): void => {
    if (peekPaneId !== null && paneExists(peekPaneId)) closePeek(peekPaneId);
    setPeekPaneId(null);
    setPeekTarget(null);
  };

  const quit = (): void => {
    if (peekPaneId !== null && paneExists(peekPaneId)) closePeek(peekPaneId);
    exit();
  };

  const drill = (entry: Entry): void => {
    const kind: PeekKind = entry.kind;
    const built = buildCommand({
      kind,
      id: entry.id,
      cityRoot: snapshot?.config.cityRoot ?? null,
      city,
      baseUrl,
    });
    if (typeof built !== 'string') {
      setStatus(`peek: ${built.error}`);
      return;
    }
    const target = `${kind}:${entry.id}`;
    const live = peekPaneId !== null && paneExists(peekPaneId);
    if (live && peekTarget === target) {
      closeActivePeek();
      setStatus('peek closed');
      return;
    }
    const r = live ? replacePeek(peekPaneId, built) : openPeek(built);
    if (r.ok) {
      if (!live) setPeekPaneId(r.paneId ?? null);
      setPeekTarget(target);
      setStatus(`peeking ${entryLabel(entry)} →`);
    } else {
      setStatus(`peek: ${r.error}`);
    }
  };

  // Exact one-line-per-row accounting prevents screen overflow. chrome =
  // header + sticky line + footer (+ error line).
  const chrome = error ? 4 : 3;
  const viewport = Math.max(3, rows - chrome);
  const maxTop = Math.max(0, renderRows.length - viewport);

  const cursorRowIndex = renderRows.findIndex(
    (r) => r.kind === 'entry' && r.index === cursorIndex,
  );
  useEffect(() => {
    if (cursorRowIndex < 0) return;
    setScrollTop((top) => {
      if (cursorRowIndex < top) return cursorRowIndex;
      if (cursorRowIndex >= top + viewport) return cursorRowIndex - viewport + 1;
      return Math.min(top, maxTop);
    });
  }, [cursorRowIndex, viewport, maxTop]);

  const effectiveTop = Math.min(scrollTop, maxTop);
  const visible = renderRows.slice(effectiveTop, effectiveTop + viewport);
  const above = effectiveTop;
  const below = Math.max(0, renderRows.length - (effectiveTop + viewport));
  const firstVisible = visible[0];
  const stickyGroup: GroupInfo | null =
    firstVisible && firstVisible.kind === 'entry' ? firstVisible.group : null;

  const toggle = (target: ViewMode): void => {
    setView((v) => (v === target ? 'list' : target));
    setScrollTop(0);
  };

  useInput(
    (input, key) => {
      if (input === 'q') return quit();
      if (key.escape) return view === 'list' ? quit() : (setView('list'), setScrollTop(0));
      if (input === 'h') return toggle('health');
      if (input === 'b') return toggle('beads');
      if (input === 'f') return toggle('runs');
      if (input === 'p') {
        if (navView === 'list') setView((v) => (v === 'detail' ? 'list' : 'detail'));
        return;
      }
      if (input === 'x') {
        closeActivePeek();
        setStatus('peek closed');
        return;
      }
      if (key.return) {
        if (selected) drill(selected);
        return;
      }
      if (key.downArrow || input === 'j') moveCursor(1);
      else if (key.upArrow || input === 'k') moveCursor(-1);
      else if (key.pageDown) moveCursor(viewport);
      else if (key.pageUp) moveCursor(-viewport);
      else if (input === 'g') moveCursor(-entries.length);
      else if (input === 'G') moveCursor(entries.length);
    },
    { isActive: Boolean(process.stdin.isTTY) },
  );

  const counts: Record<Category, number> = { failed: 0, active: 0, idle: 0 };
  for (const s of sessions) counts[categorize(s)] += 1;
  const openBeads = beads.filter((b) => b.status === 'open').length;
  const needsOpRuns = health.lanes.filter(laneNeedsOperator).length;

  const summary =
    view === 'beads' ? (
      <Text dimColor>
        beads · {openBeads} open · {beads.length} total
      </Text>
    ) : view === 'runs' ? (
      <Text dimColor>
        runs · {health.lanes.length} active
        {needsOpRuns > 0 ? <Text color="red"> · {needsOpRuns} need operator</Text> : null}
      </Text>
    ) : (
      <Text>
        {counts.failed > 0 ? (
          <Text>
            <Text color="red">{counts.failed} failed</Text>
            <Text dimColor> · </Text>
          </Text>
        ) : null}
        <Text>{counts.active} active</Text>
        <Text dimColor> · {counts.idle} idle · {sessions.length} agents</Text>
      </Text>
    );

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold>{city}</Text>
          <Text dimColor>  </Text>
          {summary}
        </Text>
        <Text dimColor>{conn === 'open' ? 'live' : conn === 'closed' ? 'reconnecting…' : conn}</Text>
      </Box>

      {error ? (
        <Box>
          <Text color="red">! {error}</Text>
        </Box>
      ) : null}

      {view === 'health' ? (
        <Box marginTop={1}>
          <HealthPane
            health={health}
            idle={neverActiveByRig(sessions)}
            pressure={contextPressure(sessions)}
            now={now}
          />
        </Box>
      ) : view === 'detail' && selectedAgent ? (
        <Box marginTop={1}>
          <DetailPane
            view={selectedAgent}
            beads={beadsForRig(beads, selectedAgent.rig)}
            lanes={lanesForRig(health.lanes, selectedAgent.rig)}
            now={now}
          />
        </Box>
      ) : (
        <>
          {stickyGroup ? (
            <Box>
              <Text dimColor>{stickyGroup.label}</Text>
              <Text dimColor>
                {'  '}
                {stickyGroup.sub} ↑
              </Text>
            </Box>
          ) : (
            <Box>
              <Text> </Text>
            </Box>
          )}
          <Box flexDirection="column">
            {renderRows.length === 0 ? (
              <Text dimColor>{emptyLabel(view)}</Text>
            ) : (
              visible.map((row, i) =>
                row.kind === 'heading' ? (
                  <Box key={`h:${row.group.label}:${effectiveTop + i}`}>
                    {row.group.alert ? (
                      <Text bold color="red">{row.group.label}</Text>
                    ) : (
                      <Text bold>{row.group.label}</Text>
                    )}
                    <Text dimColor>
                      {'  '}
                      {row.group.sub}
                    </Text>
                  </Box>
                ) : (
                  <EntryRow
                    key={`${row.entry.kind}:${row.entry.id}`}
                    entry={row.entry}
                    selected={row.index === cursorIndex}
                    dim={row.dim}
                    now={now}
                  />
                ),
              )
            )}
          </Box>
          <Box justifyContent="space-between">
            {status ? (
              <Text dimColor>{status}</Text>
            ) : (
              <Text dimColor>
                {above > 0 ? `↑ ${above} ` : '   '}
                {below > 0 ? `↓ ${below}` : ''}
              </Text>
            )}
            <Text dimColor>↑↓ · enter drill · x close · b/f/h views · p detail · q quit</Text>
          </Box>
        </>
      )}
    </Box>
  );
}

function emptyLabel(view: ViewMode): string {
  if (view === 'beads') return 'no beads';
  if (view === 'runs') return 'no active runs';
  return 'no sessions';
}

interface EntryRowProps {
  readonly entry: Entry;
  readonly selected: boolean;
  readonly dim: boolean;
  readonly now: number;
}

function EntryRow({ entry, selected, dim, now }: EntryRowProps): React.JSX.Element {
  if (entry.kind === 'agent') {
    return <AgentRow view={entry.agent} selected={selected} dim={dim} now={now} />;
  }
  if (entry.kind === 'bead') {
    return <BeadRow bead={entry.bead} selected={selected} dim={dim} />;
  }
  return <RunRow lane={entry.lane} selected={selected} />;
}
