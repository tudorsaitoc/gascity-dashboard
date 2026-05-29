import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_ALIAS_RE,
  ExecError,
  createExecRunner,
  type ExecResult,
} from '../src/exec-core.js';

describe('exec core primitives', () => {
  test('keeps subprocess errors and agent alias validation outside command wrappers', () => {
    const err = new ExecError('spawn failed: ENOENT', 'spawn');
    assert.equal(err.name, 'ExecError');
    assert.equal(err.kind, 'spawn');
    assert.match('hello-world/gastown.mayor', AGENT_ALIAS_RE);
    assert.doesNotMatch('../mayor', AGENT_ALIAS_RE);
  });

  test('createExecRunner owns concurrency per runner instance', async () => {
    const first = new FakeSpawner();
    const second = new FakeSpawner();
    const firstRunner = createExecRunner({ maxConcurrent: 1, spawnExec: first.spawn });
    const secondRunner = createExecRunner({ maxConcurrent: 1, spawnExec: second.spawn });

    const firstRun = firstRunner.runExec('fake', ['first-1'], 1_000);
    const queuedFirstRun = firstRunner.runExec('fake', ['first-2'], 1_000);
    const secondRun = secondRunner.runExec('fake', ['second-1'], 1_000);
    await flushMicrotasks();

    assert.deepEqual(first.startedArgs, [['first-1']]);
    assert.deepEqual(second.startedArgs, [['second-1']]);

    first.resolveNext();
    await flushMicrotasks();
    assert.deepEqual(first.startedArgs, [['first-1'], ['first-2']]);

    first.resolveNext();
    second.resolveNext();
    await Promise.all([firstRun, queuedFirstRun, secondRun]);
  });
});

class FakeSpawner {
  readonly startedArgs: string[][] = [];
  private readonly pending: Array<(result: ExecResult) => void> = [];

  readonly spawn = (_cmd: string, args: string[]): Promise<ExecResult> => {
    this.startedArgs.push(args);
    return new Promise((resolve) => {
      this.pending.push(resolve);
    });
  };

  resolveNext(): void {
    const resolve = this.pending.shift();
    assert.ok(resolve, 'expected a pending spawn');
    resolve({
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
      durationMs: 0,
    });
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
