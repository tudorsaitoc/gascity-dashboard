import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ViewingAs } from 'gas-city-dashboard-shared';
import { api } from '../api/client';
import { prioritizeAliases, type AliasBucket } from '../hooks/aliasPriority';

// Identity-switching for mail:
//
//   Frontend: visible "Reading as <agent>" strip with accent color when
//   ≠ the operator. The compose-from field is disabled while
//   impersonating. THE CONSTRAINT IS VISIBLE.
//
//   No client-side caching of mail under as-identity: Cache-Control:
//   no-store + no localStorage retention.
//
// We use sessionStorage so the chosen identity survives accidental page
// refresh in the same tab but does NOT persist beyond tab close — the
// "no retention" rule applies to cached mail bodies, not the user's
// chosen viewing context, but tab-scoped is friendlier here than fully
// transient.
//
// The provider also owns the alias-list prefetch. Consumers call
// loadAliases() — first call triggers the fetch, subsequent calls are
// no-ops. Lazy so non-Mail routes don't pay the cost
// (gascity-dashboard-e85 code-reviewer HIGH-1). Failures fall back to a
// list containing just the operator — the UI degrades but never breaks.

const STORAGE_KEY = 'gascity.dashboard.viewingAs';
const OPERATOR = 'stephanie';
// gc's wire identity for the operator (mail is addressed to/from `human`,
// not `stephanie` — see backend exec.ts and routes/mail.ts). The agent
// panel hides this from the switchable list so it doesn't read as a second
// inbox distinct from the operator's own.
const OPERATOR_WIRE = 'human';
const ALIAS_RE = /^[a-z][a-z0-9_./-]{1,63}$/i;

interface ViewingAsContextValue {
  viewingAs: ViewingAs;
  setAlias: (alias: string) => void;
  resetToOperator: () => void;
  /** Prioritized alias buckets (you / mayor / active / other). */
  aliasBuckets: ReadonlyArray<AliasBucket>;
  /** True iff loadAliases() has been called and the fetch is in-flight. */
  aliasesLoading: boolean;
  /**
   * Idempotently trigger the alias prefetch. First caller starts the
   * fetch; subsequent callers are no-ops. Routes that need the dropdown
   * (Mail) call this on mount; other routes never pay the cost.
   */
  loadAliases: () => void;
}

const Context = createContext<ViewingAsContextValue | null>(null);

function readStored(): string {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (typeof raw === 'string' && raw.length > 0 && raw.length <= 64) return raw;
  } catch {
    /* sessionStorage may be unavailable */
  }
  return OPERATOR;
}

function writeStored(alias: string): void {
  try {
    if (alias === OPERATOR) {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(STORAGE_KEY, alias);
    }
  } catch {
    /* no-op */
  }
}

export function ViewingAsProvider({ children }: { children: ReactNode }) {
  const [alias, setAliasState] = useState<string>(() => readStored());
  const [sessionAliases, setSessionAliases] = useState<string[]>([]);
  const [mailFromOrTo, setMailFromOrTo] = useState<string[]>([]);
  const [aliasesLoading, setAliasesLoading] = useState<boolean>(false);
  // Single-flight guard: first loadAliases call wins; subsequent calls
  // (re-renders, StrictMode double-mount, multiple consumers) are no-ops.
  const startedRef = useRef<boolean>(false);
  // The mounted flag protects state setters from firing after provider
  // unmount. Initialized via a ref-callback in the effect below so that
  // StrictMode's mount → cleanup → re-mount cycle correctly leaves the
  // ref `true` between the two mounts. (A naive `useRef(true)` + cleanup
  // pattern leaves the ref permanently `false` after the first cleanup.)
  const mountedRef = useRef<boolean>(true);

  const setAlias = useCallback((next: string) => {
    setAliasState(next);
    writeStored(next);
  }, []);

  const resetToOperator = useCallback(() => {
    setAliasState(OPERATOR);
    writeStored(OPERATOR);
  }, []);

  // Idempotent lazy prefetch. First caller wins; subsequent calls
  // (re-renders, multiple consumers) are no-ops. Both fetches are read
  // requests; either failing leaves the dropdown with just the operator
  // entry (still functional).
  const loadAliases = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    setAliasesLoading(true);

    // Resolve each source independently rather than awaiting both: the
    // mail corpus returns in ~0.5s while /api/sessions can take many
    // seconds (or time out). Gating both behind Promise.allSettled held
    // the fast mail-derived aliases hostage to the slow one, leaving the
    // agent panel stuck on "loading" for the full sessions latency.
    // Loading clears only when BOTH have settled (footnote, not full
    // block), but the lists populate the moment each arrives.
    let pending = 2;
    const settleOne = () => {
      pending -= 1;
      if (pending === 0 && mountedRef.current) setAliasesLoading(false);
    };

    void api
      .listSessions()
      .then((sessions) => {
        if (!mountedRef.current) return;
        const seen = new Set<string>();
        const out: string[] = [];
        for (const s of sessions.items) {
          if (typeof s.alias !== 'string') continue;
          if (!ALIAS_RE.test(s.alias)) continue;
          const key = s.alias.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(s.alias);
        }
        setSessionAliases(out);
      })
      .catch(() => {
        /* sessions unavailable — panel still works off mail-derived aliases */
      })
      .finally(settleOne);

    void api
      // Backend ignores alias for box='all' (returns the full corpus for
      // client-side aggregation). The operator alias is passed only to
      // satisfy the typed wrapper.
      .listMail('all', OPERATOR)
      .then((mail) => {
        if (!mountedRef.current) return;
        const seen = new Set<string>();
        const out: string[] = [];
        for (const m of mail.items) {
          for (const candidate of [m.from, m.to]) {
            if (typeof candidate !== 'string' || candidate.length === 0) continue;
            if (!ALIAS_RE.test(candidate)) continue;
            const key = candidate.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(candidate);
          }
        }
        setMailFromOrTo(out);
      })
      .catch(() => {
        /* mail corpus unavailable — falls back to sessions + operator */
      })
      .finally(settleOne);
  }, []);

  // Re-mount-aware mounted flag. The effect body sets mountedRef.current
  // = true on every mount (covering StrictMode's mount → cleanup → re-mount
  // cycle), and the cleanup sets it false on real unmount. The async IIFE
  // checks this flag before touching state.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const aliasBuckets = useMemo(
    () =>
      prioritizeAliases({
        operator: OPERATOR,
        // Inject the current alias so the <select> always has a matching
        // <option> even if a stored alias has aged out of /api/sessions
        // (code-reviewer HIGH-2: prevents blank-selection visual mismatch).
        sessionAliases: sessionAliases.includes(alias)
          ? sessionAliases
          : [...sessionAliases, alias],
        mailFromOrTo,
      }),
    [sessionAliases, mailFromOrTo, alias],
  );

  const value = useMemo<ViewingAsContextValue>(
    () => ({
      viewingAs: { alias, isOperator: alias === OPERATOR },
      setAlias,
      resetToOperator,
      aliasBuckets,
      aliasesLoading,
      loadAliases,
    }),
    [alias, setAlias, resetToOperator, aliasBuckets, aliasesLoading, loadAliases],
  );

  // Strict: when the tab is hidden (parent walked away), revert to the
  // operator. Stops a forgotten "reading as X" state from being live the
  // next time someone glances at the laptop.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden && alias !== OPERATOR) {
        setAliasState(OPERATOR);
        writeStored(OPERATOR);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [alias]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useViewingAs(): ViewingAsContextValue {
  const value = useContext(Context);
  if (value === null) {
    throw new Error('useViewingAs must be inside <ViewingAsProvider>');
  }
  return value;
}

export const OPERATOR_ALIAS = OPERATOR;
export const OPERATOR_WIRE_ALIAS = OPERATOR_WIRE;
