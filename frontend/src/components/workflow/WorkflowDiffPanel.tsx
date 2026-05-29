import type { WorkflowDiffResponse } from 'gas-city-dashboard-shared';

interface WorkflowDiffPanelProps {
  diff: WorkflowDiffResponse;
}

export function WorkflowDiffPanel({ diff }: WorkflowDiffPanelProps) {
  if (diff.kind === 'path_unknown') {
    return <p className="text-body text-fg-muted italic">Execution folder is unknown for this run.</p>;
  }
  if (diff.kind === 'not_git') {
    return <p className="text-body text-fg-muted italic">Execution folder is not a git work tree.</p>;
  }
  if (diff.kind === 'error') {
    return (
      <p className="text-body text-accent" role="alert">
        {diff.error}
      </p>
    );
  }

  return (
    <section>
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <h3 className="text-body font-semibold text-fg">Current Working Tree</h3>
        <span className="text-label uppercase tracking-wider text-fg-faint tnum">
          {diff.changedFiles.length} changed file{diff.changedFiles.length === 1 ? '' : 's'}
        </span>
      </div>
      {diff.rootPath.kind === 'known' && (
        <p className="mt-1 text-label text-fg-faint break-all">{diff.rootPath.path}</p>
      )}
      {diff.changedFiles.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-label uppercase tracking-wider text-fg-muted">
          {diff.changedFiles.map((file) => (
            <li key={`${file.status}:${file.path}`}>
              {file.status} {file.path} <span className="text-fg-faint">({file.kind})</span>
            </li>
          ))}
        </ul>
      )}
      {!diff.unstagedDiff && !diff.stagedDiff ? (
        <p className="mt-5 text-body text-fg-muted italic">No tracked-file diff in this work tree.</p>
      ) : (
        <div className="mt-5 space-y-5">
          {diff.unstagedDiff && (
            <DiffBlock title="Unstaged Diff" body={diff.unstagedDiff} />
          )}
          {diff.stagedDiff && (
            <DiffBlock title="Staged Diff" body={diff.stagedDiff} />
          )}
        </div>
      )}
      {diff.truncated && (
        <p className="mt-3 text-label uppercase tracking-wider text-fg-faint">
          Diff truncated at the backend output cap.
        </p>
      )}
    </section>
  );
}

function DiffBlock({ title, body }: { title: string; body: string }) {
  return (
    <section aria-label={title}>
      <h4 className="text-label uppercase tracking-wider text-fg-faint">{title}</h4>
      <pre className="mt-2 overflow-auto text-[0.8125rem] leading-relaxed border-y border-rule py-3">
        {body.split('\n').map((line, index) => (
          <code
            key={`${index}:${line}`}
            className={`block whitespace-pre ${diffLineClass(line)}`}
          >
            {line || ' '}
          </code>
        ))}
      </pre>
    </section>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) {
    return 'diff-line-file text-fg';
  }
  // Diff lines are body type; the +/-/@@ glyph carries the state (Greyscale
  // Test), so they stay neutral. Coloring them — maroon worst of all — would
  // breach the One Mark Rule and put accent on body type (DESIGN.md §2).
  // gascity-dashboard-rl5y.
  if (line.startsWith('@@')) return 'diff-line-hunk text-fg-faint';
  if (line.startsWith('+')) return 'diff-line-add text-fg';
  if (line.startsWith('-')) return 'diff-line-remove text-fg-muted';
  return 'diff-line-context text-fg-muted';
}
