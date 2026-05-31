import type { BeadNode } from '../../lib/beadGraph';

// One bead on the board, in the editorial register: a typeset row, no card,
// no side-stripe. Selection is carried by weight + a leading "▸" + a warm
// surface tint, never by a colored left edge (DESIGN.md §6). The dependency
// graph is navigated hop by hop: a selected row expands its upstream
// (`needs`) and downstream (`blocks`) neighbours as typeset tree rows, each
// a button that re-centres selection on that bead. Out-of-window edges are
// rendered `unresolved` in caution ochre, never fabricated.

interface BeadBoardRowProps {
  node: BeadNode;
  selected: boolean;
  onSelect: (beadId: string) => void;
}

export function BeadBoardRow({ node, selected, onSelect }: BeadBoardRowProps) {
  const { bead, deps, blocks, hasUnresolvedDeps } = node;
  const depCount = deps.length;
  const blockCount = blocks.length;
  const hasNeighbourhood = depCount > 0 || blockCount > 0;

  return (
    <li
      className={`px-2 py-2 -mx-2 rounded-sm transition-colors duration-150 ease-out-quart ${
        selected ? 'bg-surface-tint' : 'hover:bg-surface-tint/60'
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(bead.id)}
        className="text-left w-full focus-mark rounded-sm"
        aria-pressed={selected}
        title={`Select ${bead.id}`}
      >
        <span className="flex items-baseline gap-2">
          <span className="text-fg-faint" aria-hidden="true">
            {selected ? '▸' : ' '}
          </span>
          <span
            className={`min-w-0 truncate text-body ${
              selected ? 'text-fg font-medium' : 'text-fg'
            }`}
          >
            {bead.title}
          </span>
        </span>
        <span className="flex items-baseline gap-3 pl-4 mt-0.5 text-label uppercase tracking-wider text-fg-faint">
          <span className="tnum">{bead.id}</span>
          {bead.priority !== null && (
            <span className="tnum">P{bead.priority}</span>
          )}
          {hasNeighbourhood && (
            <span className="tnum normal-case tracking-normal">
              {depCount > 0 && `needs ${depCount}`}
              {depCount > 0 && blockCount > 0 && ' · '}
              {blockCount > 0 && `blocks ${blockCount}`}
            </span>
          )}
          {hasUnresolvedDeps && (
            <span className="normal-case tracking-normal text-warn">
              unresolved
            </span>
          )}
        </span>
      </button>

      {selected && hasNeighbourhood && (
        <ul className="mt-2 pl-4 space-y-1">
          {deps.map((dep, i) => (
            <DepRow
              key={`needs-${dep.id}`}
              connector={i === deps.length - 1 && blockCount === 0 ? '└' : '├'}
              relation={`needs ${dep.kind === 'needs' ? '' : `(${dep.kind})`}`.trim()}
              targetId={dep.id}
              targetTitle={dep.bead?.title ?? null}
              {...(dep.bead ? { onSelect } : {})}
            />
          ))}
          {blocks.map((b, i) => (
            <DepRow
              key={`blocks-${b.id}`}
              connector={i === blocks.length - 1 ? '└' : '├'}
              relation="blocks"
              targetId={b.id}
              targetTitle={b.title}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

interface DepRowProps {
  connector: string;
  relation: string;
  targetId: string;
  targetTitle: string | null;
  /** Undefined when the target is outside the fetched window (unresolved). */
  onSelect?: (beadId: string) => void;
}

function DepRow({
  connector,
  relation,
  targetId,
  targetTitle,
  onSelect,
}: DepRowProps) {
  const label = (
    <>
      <span className="text-label uppercase tracking-wider text-fg-faint">
        {relation}
      </span>{' '}
      <span className="tnum text-fg-muted">{targetId}</span>
      {targetTitle && (
        <span className="text-fg-muted"> · {targetTitle}</span>
      )}
    </>
  );

  return (
    <li className="text-body leading-snug">
      <span className="text-fg-faint mr-1" aria-hidden="true">
        {connector}
      </span>
      {onSelect ? (
        <button
          type="button"
          onClick={() => onSelect(targetId)}
          className="text-left hover:text-fg focus-mark rounded-sm"
          title={`Select ${targetId}`}
        >
          {label}
        </button>
      ) : (
        <span title="Outside the fetched window">
          {label}{' '}
          <span className="text-warn text-label uppercase tracking-wider">
            unresolved
          </span>
        </span>
      )}
    </li>
  );
}
