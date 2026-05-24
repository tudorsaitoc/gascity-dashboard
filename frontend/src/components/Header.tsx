import { NavLink } from 'react-router-dom';
import { useTheme } from '../contexts/ThemeContext';
import { useViewingAs } from '../contexts/ViewingAsContext';

const ROUTES: { to: string; label: string }[] = [
  { to: '/agents', label: 'Agents' },
  { to: '/beads', label: 'Beads' },
  { to: '/workflows', label: 'Workflows' },
  { to: '/mail', label: 'Mail' },
  { to: '/activity', label: 'Activity' },
  { to: '/health', label: 'Health' },
  { to: '/maintainer', label: 'Triage' },
];

// The header is page furniture, not chrome. A small wordmark, the
// five route names typeset as a row, a textual theme toggle. The
// route weight contrast IS the active-state affordance; no underline,
// no background pill.
export function Header() {
  const { resolved, toggle } = useTheme();
  const { viewingAs } = useViewingAs();

  return (
    <header className="border-b border-rule">
      <div className="max-w-[1280px] mx-auto px-4 sm:px-6 lg:px-8 py-5 flex items-baseline gap-x-6 lg:gap-x-8 gap-y-2 flex-wrap">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="text-title font-semibold tracking-tight text-fg">
            gas city
          </span>
          <span className="text-fg-muted" aria-hidden="true">·</span>
          <span className="text-label uppercase tracking-wider text-fg-muted">
            ds-research
          </span>
          {!viewingAs.isOperator && (
            <span className="text-label uppercase tracking-wider text-accent ml-3">
              · reading as {viewingAs.alias}
            </span>
          )}
        </div>

        <nav className="flex-1">
          <ul className="flex items-baseline gap-x-5 lg:gap-x-7 gap-y-1 flex-wrap">
            {ROUTES.map((r) => (
              <li key={r.to}>
                <NavLink
                  to={r.to}
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
