import { useCallback, useEffect, useMemo, useState } from 'react';

// useListFilters: per-view search + filter chips + project grouping
// with collapse state persisted per view in localStorage.
//
// Search and chip state are NOT persisted — they reset between
// sessions because the operator is filtering for "right now". Only
// collapsed-group ids persist, because the operator's mental model
// of which projects she's currently ignoring is stable across visits.

export interface FilterChip<T> {
  /** Stable id used for active-set membership and persistence. */
  id: string;
  /** Human-readable label rendered in the chip. */
  label: string;
  /** Predicate: row passes this chip when match returns true. */
  match: (row: T) => boolean;
}

export interface ProjectGroup<T> {
  project: string;
  rows: ReadonlyArray<T>;
  /** Count of rows in the project AFTER filters but BEFORE collapse. */
  totalInProject: number;
  collapsed: boolean;
}

interface UseListFiltersOptions<T> {
  /** Stable per-view key, e.g. 'beads' | 'agents' | 'mail'. */
  viewKey: string;
  rows: ReadonlyArray<T>;
  /** Derive the project bucket for a row. */
  projectOf: (row: T) => string;
  /** Strings to consider for substring search. */
  searchOf: (row: T) => ReadonlyArray<string | undefined | null>;
  chips: ReadonlyArray<FilterChip<T>>;
}

interface UseListFiltersResult<T> {
  search: string;
  setSearch: (v: string) => void;
  activeChipIds: ReadonlySet<string>;
  toggleChip: (id: string) => void;
  isCollapsed: (project: string) => boolean;
  toggleProject: (project: string) => void;
  /** All visible projects (after filters), sorted alphabetically. Empty when no rows match. */
  groups: ReadonlyArray<ProjectGroup<T>>;
  /** Total matching rows across all projects (BEFORE collapse). */
  totalMatches: number;
}

const STORAGE_PREFIX = 'gcd:listFilters:collapsed:';

function loadCollapsed(viewKey: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + viewKey);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((v): v is string => typeof v === 'string'));
    }
  } catch {
    /* corrupt storage: ignore, start fresh */
  }
  return new Set();
}

function saveCollapsed(viewKey: string, ids: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(
      STORAGE_PREFIX + viewKey,
      JSON.stringify(Array.from(ids)),
    );
  } catch {
    /* quota or disabled storage: silently degrade */
  }
}

export function useListFilters<T>({
  viewKey,
  rows,
  projectOf,
  searchOf,
  chips,
}: UseListFiltersOptions<T>): UseListFiltersResult<T> {
  const [search, setSearch] = useState('');
  const [activeChipIds, setActiveChipIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() =>
    loadCollapsed(viewKey),
  );

  // When the view key changes (e.g. Mail switching inbox <-> sent),
  // reload persisted collapse AND reset ephemeral search/chip state.
  // Without the reset, an "unread" chip activated in inbox would
  // silently filter Sent (all read), making the box appear empty.
  useEffect(() => {
    setCollapsed(loadCollapsed(viewKey));
    setSearch('');
    setActiveChipIds(new Set());
  }, [viewKey]);

  const toggleChip = useCallback((id: string) => {
    setActiveChipIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleProject = useCallback(
    (project: string) => {
      setCollapsed((cur) => {
        const next = new Set(cur);
        if (next.has(project)) next.delete(project);
        else next.add(project);
        saveCollapsed(viewKey, next);
        return next;
      });
    },
    [viewKey],
  );

  const isCollapsed = useCallback(
    (project: string) => collapsed.has(project),
    [collapsed],
  );

  const groups = useMemo<ReadonlyArray<ProjectGroup<T>>>(() => {
    const needle = search.trim().toLowerCase();
    const activeChips = chips.filter((c) => activeChipIds.has(c.id));

    const matchesSearch = (row: T): boolean => {
      if (needle.length === 0) return true;
      for (const field of searchOf(row)) {
        if (field && field.toLowerCase().includes(needle)) return true;
      }
      return false;
    };

    const matchesChips = (row: T): boolean => {
      if (activeChips.length === 0) return true;
      // Multi-chip = OR (union). The operator broadens by adding chips,
      // not narrows: selecting "open + in_progress" should show both.
      for (const chip of activeChips) {
        if (chip.match(row)) return true;
      }
      return false;
    };

    const buckets = new Map<string, T[]>();
    for (const row of rows) {
      if (!matchesSearch(row)) continue;
      if (!matchesChips(row)) continue;
      const proj = projectOf(row);
      const bucket = buckets.get(proj);
      if (bucket) bucket.push(row);
      else buckets.set(proj, [row]);
    }

    const projects = Array.from(buckets.keys()).sort();
    return projects.map((project) => {
      const projRows = buckets.get(project) ?? [];
      return {
        project,
        rows: projRows,
        totalInProject: projRows.length,
        collapsed: collapsed.has(project),
      };
    });
  }, [rows, search, activeChipIds, chips, projectOf, searchOf, collapsed]);

  const totalMatches = useMemo(
    () => groups.reduce((sum, g) => sum + g.totalInProject, 0),
    [groups],
  );

  return {
    search,
    setSearch,
    activeChipIds,
    toggleChip,
    isCollapsed,
    toggleProject,
    groups,
    totalMatches,
  };
}
