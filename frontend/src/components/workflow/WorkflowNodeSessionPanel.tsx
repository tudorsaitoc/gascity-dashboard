import { useEffect, useMemo, useState } from 'react';
import type {
  WorkflowDisplayNode,
  WorkflowExecutionInstance,
} from 'gas-city-dashboard-shared';
import { SessionPeekContent } from '../SessionPeek';
import { useSessionStream } from '../../hooks/useSessionStream';

interface WorkflowNodeSessionPanelProps {
  node: WorkflowDisplayNode | null;
  visible: boolean;
}

export function WorkflowNodeSessionPanel({
  node,
  visible,
}: WorkflowNodeSessionPanelProps) {
  const sessionInstances = useMemo(
    () =>
      node?.executionInstances
        .filter((instance) => instance.sessionLink)
        .sort(compareInstances) ?? [],
    [node],
  );
  const defaultInstance = useMemo(
    () => preferredInstance(sessionInstances),
    [sessionInstances],
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    setSelectedKey(defaultInstance ? instanceKey(defaultInstance) : null);
  }, [node?.id, defaultInstance]);

  if (!node) {
    return <p className="text-body text-fg-muted italic">Select a node to inspect its session.</p>;
  }
  if (sessionInstances.length === 0) {
    return <p className="text-body text-fg-muted italic">No session is attached to this node.</p>;
  }

  const selected =
    sessionInstances.find((instance) => instanceKey(instance) === selectedKey) ??
    defaultInstance ??
    sessionInstances[0];
  const selectedIteration = selected?.iteration ?? null;
  const iterationGroups = groupIterations(sessionInstances);
  const attempts = sessionInstances.filter(
    (instance) => (instance.iteration ?? null) === selectedIteration,
  );
  if (!selected) {
    return <p className="text-body text-fg-muted italic">No session is attached to this node.</p>;
  }

  return (
    <section>
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="text-body font-semibold text-fg">{node.title}</h3>
        {selected?.historical && (
          <span className="text-label uppercase tracking-wider text-fg-faint">
            historical
          </span>
        )}
      </div>
      {iterationGroups.length > 1 && (
        <div
          className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-label"
          role="radiogroup"
          aria-label="Iterations"
        >
          <span className="uppercase tracking-wider text-fg-faint">Iterations</span>
          {iterationGroups.map((group) => {
            const instance = group.instances.at(-1);
            if (!instance) return null;
            const label = group.iteration === null ? 'Base' : `Iteration ${group.iteration}`;
            const active = group.iteration === selectedIteration;
            return (
              <span key={label} className="flex items-baseline gap-1">
                <span aria-hidden className="text-fg-faint">·</span>
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`focus-mark rounded-sm px-0.5 uppercase tracking-wider ${
                    active
                      ? 'text-fg font-semibold underline decoration-fg underline-offset-4'
                      : 'text-fg-muted hover:text-fg'
                  }`}
                  onClick={() => setSelectedKey(instanceKey(instance))}
                >
                  {label}
                </button>
              </span>
            );
          })}
        </div>
      )}
      {attempts.length > 1 && (
        <div
          className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-label"
          role="radiogroup"
          aria-label="Attempts"
        >
          <span className="uppercase tracking-wider text-fg-faint">Attempts</span>
          {attempts.map((instance) => (
            <span key={instanceKey(instance)} className="flex items-baseline gap-1">
              <span aria-hidden className="text-fg-faint">·</span>
              <button
                type="button"
                role="radio"
                aria-checked={instanceKey(instance) === instanceKey(selected)}
                className={`focus-mark rounded-sm px-0.5 uppercase tracking-wider ${
                  instanceKey(instance) === instanceKey(selected)
                    ? 'text-fg font-semibold underline decoration-fg underline-offset-4'
                    : 'text-fg-muted hover:text-fg'
                }`}
                onClick={() => setSelectedKey(instanceKey(instance))}
              >
                Attempt {instance.attempt ?? 1}
              </button>
            </span>
          ))}
        </div>
      )}
      <SessionTranscript instance={selected} visible={visible} />
    </section>
  );
}

function SessionTranscript({
  instance,
  visible,
}: {
  instance: WorkflowExecutionInstance;
  visible: boolean;
}) {
  const sessionId = instance.sessionLink?.sessionId ?? null;
  const stream = visible && Boolean(instance.streamable);
  const { result, loading, error } = useSessionStream(sessionId, stream);
  return (
    <div className="mt-5">
      <SessionPeekContent loading={loading} error={error} result={result} />
    </div>
  );
}

function preferredInstance(
  instances: WorkflowExecutionInstance[],
): WorkflowExecutionInstance | undefined {
  return (
    instances.find((instance) => instance.streamable) ??
    [...instances].sort(compareInstances).at(-1)
  );
}

function groupIterations(instances: WorkflowExecutionInstance[]) {
  const groups = new Map<number | null, WorkflowExecutionInstance[]>();
  for (const instance of instances) {
    const key = instance.iteration ?? null;
    groups.set(key, [...(groups.get(key) ?? []), instance]);
  }
  return [...groups.entries()]
    .map(([iteration, groupInstances]) => ({
      iteration,
      instances: groupInstances.sort(compareInstances),
    }))
    .sort((a, b) => (a.iteration ?? 0) - (b.iteration ?? 0));
}

function compareInstances(
  left: WorkflowExecutionInstance,
  right: WorkflowExecutionInstance,
): number {
  return (
    (left.iteration ?? 0) - (right.iteration ?? 0) ||
    (left.attempt ?? 0) - (right.attempt ?? 0) ||
    left.id.localeCompare(right.id)
  );
}

function instanceKey(instance: WorkflowExecutionInstance): string {
  return instance.id;
}
