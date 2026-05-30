import { NavLink, useLocation } from 'react-router-dom';
import { api } from '../api/client';
import { useTheme } from '../contexts/ThemeContext';
import { useViewingAs, OPERATOR_ALIAS } from '../contexts/ViewingAsContext';
import { displayLabel } from '../hooks/aliasPriority';
import { useCachedData } from '../hooks/useCachedData';
import { ALL_VIEWS } from '../views/registry';

interface NavRoute {
  to: string;
  label: string;
  end?: boolean;
  order: number;
}

// Hand-maintained routes for the views that PR-A has NOT yet ported to
// the modular registry. Each entry carries an explicit `order` so the
// registry-driven entries (currently /health at 60) interleave cleanly
// here without a separate "where does Health go" decision. PR-B+ will
// move entries out of this list as they land in ALL_VIEWS.
const EXPLICIT_ROUTES: ReadonlyArray<NavRoute> = [
  // gascity-dashboard-kb3: Home is the L0 ambient page at `/`.
  // `end: true` so the NavLink active-state matches `/` exactly
  // (otherwise every nested route would also be 'active').
  { to: '/', label: 'Home', end: true, order: 10 },
  { to: '/agents', label: 'Agents', order: 20 },
  { to: '/beads', label: 'Beads', order: 30 },
  { to: '/workflows', label: 'Workflows', order: 40 },
  { to: '/mail', label: 'Mail', order: 50 },
  { to: '/activity', label: 'Activity', order: 55 },
];

const REGISTRY_ROUTES: ReadonlyArray<NavRoute> = ALL_VIEWS.flatMap((v) => {
  if (v.nav === null) return [];
  return [{
    to: v.path,
    label: v.nav.label,
    end: v.path === '/',
    order: v.nav.order,
  }];
});

// Spread already allocates a new mutable array, so .sort() in-place is
// safe — no .slice() needed (PR-A Phase-4 TS M4).
const ROUTES: ReadonlyArray<NavRoute> = [...EXPLICIT_ROUTES, ...REGISTRY_ROUTES]
  .sort((a, b) => a.order - b.order);

// The header is page furniture, not chrome. A small wordmark, the
// five route names typeset as a row, a textual theme toggle. The
// route weight contrast IS the active-state affordance; no underline,
// no background pill.
export function Header() {
  const { resolved, toggle } = useTheme();
  const { viewingAs } = useViewingAs();
  const { data: config } = useCachedData('config', () => api.config());
  const { pathname } = useLocation();
  // "Reading as" is a Mail-only concept — the value persists across views
  // (for Maintainer's impersonation guard + AgentDetail's chat filter) but
  // the header indicator only makes sense inside the mail surface.
  const showReadingAs = !viewingAs.isOperator && pathname.startsWith('/mail');

  return (
    <header className="border-b border-rule">
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-8 py-5 flex items-baseline gap-x-6 lg:gap-x-8 gap-y-2 flex-wrap">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="text-title font-semibold tracking-tight text-fg">
            gas city
          </span>
          <span className="text-fg-muted" aria-hidden="true">·</span>
          <span className="text-label uppercase tracking-wider text-fg-muted">
            {config?.cityName ?? 'city'}
          </span>
          {showReadingAs && (
            <span className="text-label uppercase tracking-wider text-accent ml-3">
              · reading as {displayLabel(viewingAs.alias, OPERATOR_ALIAS)}
            </span>
          )}
        </div>

        <nav className="flex-1">
          <ul className="flex items-baseline gap-x-5 lg:gap-x-7 gap-y-1 flex-wrap">
            {ROUTES.map((r) => (
              <li key={r.to}>
                <NavLink
                  to={r.to}
                  end={r.end ?? false}
                  className={({ isActive }) =>
                    [
                      'text-title transition-colors duration-150 ease-out-quart focus-mark',
                      isActive
                        ? 'text-fg font-semibold'
                        : 'text-fg-muted font-medium hover:text-fg',
                    ].join(' ')
                  }
                >
                  {r.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <button
          type="button"
          onClick={toggle}
          aria-label={`Switch to ${resolved === 'dark' ? 'light' : 'dark'} theme`}
          className="text-label uppercase tracking-wider text-fg-muted hover:text-fg transition-colors duration-150 ease-out-quart focus-mark"
        >
          {resolved === 'dark' ? 'Light' : 'Dark'}
        </button>
      </div>
    </header>
  );
}
