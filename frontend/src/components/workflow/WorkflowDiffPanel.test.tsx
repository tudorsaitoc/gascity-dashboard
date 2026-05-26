import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowDiffResponse } from 'gas-city-dashboard-shared';
import { WorkflowDiffPanel } from './WorkflowDiffPanel';

afterEach(() => cleanup());

describe('WorkflowDiffPanel', () => {
  it('shows quiet skipped states when the execution folder is unknown or not git', () => {
    const { rerender } = render(<WorkflowDiffPanel diff={diffFor('path_unknown')} />);

    expect(screen.getByText(/execution folder is unknown/i)).toBeTruthy();

    rerender(<WorkflowDiffPanel diff={diffFor('not_git')} />);
    expect(screen.getByText(/not a git work tree/i)).toBeTruthy();
  });

  it('labels staged and unstaged diffs and preserves prefix-based color classes', () => {
    const { container } = render(
      <WorkflowDiffPanel
        diff={{
          kind: 'ok',
          rootPath: '/tmp/rig',
          status: [' M src/workflow.ts', 'A  src/workflow.test.ts'],
          changedFiles: [
            { path: 'src/workflow.ts', status: 'M', kind: 'code' },
            { path: 'src/workflow.test.ts', status: 'A', kind: 'test' },
          ],
          unstagedDiff: [
            'diff --git a/src/workflow.ts b/src/workflow.ts',
            '@@ -1 +1 @@',
            '-old session',
            '+new session',
          ].join('\n'),
          stagedDiff: [
            'diff --git a/src/workflow.test.ts b/src/workflow.test.ts',
            '@@ -0,0 +1 @@',
            '+test coverage',
          ].join('\n'),
          truncated: true,
        }}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Unstaged Diff' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Staged Diff' })).toBeTruthy();
    expect(screen.getByText(/diff truncated/i)).toBeTruthy();
    expect(container.querySelector('.diff-line-add')?.textContent).toContain('+new session');
    expect(container.querySelector('.diff-line-remove')?.textContent).toContain('-old session');
    expect(container.querySelector('.diff-line-hunk')?.textContent).toContain('@@');
  });
});

function diffFor(kind: 'path_unknown' | 'not_git'): WorkflowDiffResponse {
  return {
    kind,
    rootPath: null,
    status: [],
    changedFiles: [],
    unstagedDiff: '',
    stagedDiff: '',
    truncated: false,
  };
}
