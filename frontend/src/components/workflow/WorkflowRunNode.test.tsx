import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkflowConstructKind,
  WorkflowDisplayNode,
} from 'gas-city-dashboard-shared';
import { WorkflowRunNode } from './WorkflowRunNode';

afterEach(() => cleanup());

describe('WorkflowRunNode', () => {
  it('uses distinct shape classes for first-pass graph.v2 constructs', () => {
    const constructs: WorkflowConstructKind[] = [
      'workflow-root',
      'step',
      'retry',
      'check-loop',
      'scope',
      'condition',
      'fanout',
      'expansion',
    ];
    const classes = new Map<string, string>();

    for (const constructKind of constructs) {
      const { unmount } = render(
        <WorkflowRunNode
          node={nodeFor(constructKind)}
          selected={false}
          onToggle={vi.fn()}
        />,
      );
      const button = screen.getByRole('button', {
        name: new RegExp(`sample ${constructKind.replace(/-/g, ' ')}`, 'i'),
      });
      const shapeClass = [...button.classList].find((className) =>
        className.startsWith('workflow-node-shape-'),
      );
      expect(shapeClass, constructKind).toBeTruthy();
      classes.set(constructKind, shapeClass ?? '');
      unmount();
    }

    expect(new Set(classes.values()).size).toBe(constructs.length);
    expect(classes.get('workflow-root')).toBe('workflow-node-shape-root');
    expect(classes.get('fanout')).not.toBe(classes.get('expansion'));
  });
});

function nodeFor(constructKind: WorkflowConstructKind): WorkflowDisplayNode {
  return {
    id: `sample-${constructKind}`,
    semanticNodeId: `sample-${constructKind}`,
    title: `Sample ${constructKind.replace(/-/g, ' ')}`,
    kind: constructKind,
    constructKind,
    status: 'pending',
    executionInstances: [],
  };
}
