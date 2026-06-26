import { Link } from 'react-router-dom';
import { Button } from '../components/Button';
import { PageHeader } from '../components/PageHeader';
import { PartialDataNotice } from '../components/PartialDataNotice';
import { describeBeadStatus } from '../lib/beadStatusGlyph';
import { useConvoyRoots } from '../hooks/useConvoyRoots';
import type { ConvoyRootSummary } from '../supervisor/convoyReads';

// The /convoy index (gascity-dashboard-0chv3): the front door the detail page
// never had. It lists the active convoys (graph.v2 run roots still in flight)
// derived from the same bounded city bead scan the detail page uses, each row
// linking to the existing /convoy/:rootBead view. Status reads neutral (One Mark
// Rule: a list must not paint several maroons); the empty city is a calm notice,
// not an alert.

const TITLE_FALLBACK_TOOLTIP =
  'name inferred from bead title; supervisor did not set gc.formula on this graph.v2 root';

export function ConvoyIndex() {
  const { state, refresh } = useConvoyRoots();

  const ready = state.kind === 'ready' ? state : null;
  const loading = state.kind === 'loading';
  const refreshing = ready?.refreshing ?? false;
  const roots = ready?.load.roots ?? [];

  return (
    <section>
      <PageHeader
        title="Convoys"
        synopsis={ready ? convoysSynopsis(roots.length) : undefined}
        meta={
          <Button size="sm" onClick={() => void refresh()} disabled={loading || refreshing}>
            {refreshing ? 'Refreshing' : 'Refresh'}
          </Button>
        }
      />

      {loading ? (
        <p className="text-body text-fg-muted italic">Loading convoys.</p>
      ) : state.kind === 'failed' ? (
        <p className="text-body text-accent" role="alert">
          {state.error}
        </p>
      ) : ready ? (
        <>
          {ready.load.partial && (
            <PartialDataNotice
              glyph="◐"
              label="Partial list: the city bead read was truncated, so some convoys may be missing."
              title="Raise the fetch window if convoys sit past the bounded read."
            />
          )}
          {roots.length === 0 ? (
            <p className="text-body text-fg-muted" role="status">
              No active convoys.
            </p>
          ) : (
            <ol className="space-y-3">
              {roots.map((root) => (
                <ConvoyRootRow key={root.rootBeadId} root={root} />
              ))}
            </ol>
          )}
        </>
      ) : null}
    </section>
  );
}

function convoysSynopsis(count: number): string {
  return count === 1 ? '1 active convoy.' : `${count} active convoys.`;
}

function ConvoyRootRow({ root }: { root: ConvoyRootSummary }) {
  const status = describeBeadStatus(root.status);
  const inferred = root.formulaNameProvenance === 'title_fallback';
  const name = root.formulaName ?? root.title;
  return (
    <li className="border-b border-rule pb-3 last:border-b-0">
      <div className="flex items-baseline justify-between gap-3">
        <Link
          to={`/convoy/${encodeURIComponent(root.rootBeadId)}`}
          className="focus-mark text-body text-fg hover:text-accent leading-snug min-w-0 break-words"
        >
          {name}
        </Link>
        <span className="text-label uppercase tracking-wider text-fg-muted shrink-0">
          <span aria-hidden="true">{status.glyph}</span> {status.word}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 text-label uppercase tracking-wider text-fg-faint">
        <span className="tnum">{root.rootBeadId}</span>
        {inferred && (
          <span className="text-warn" title={TITLE_FALLBACK_TOOLTIP}>
            name inferred from bead title
          </span>
        )}
      </div>
    </li>
  );
}
