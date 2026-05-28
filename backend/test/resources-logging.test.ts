import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { collectResources } from '../src/snapshot/collectors/resources.js';
import { LOG_COMPONENT } from '../src/logging.js';

describe('collectResources fallback visibility', () => {
  test('logs meminfo read failures before falling back to node:os memory values', async () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };

    try {
      const resources = await collectResources({
        meminfoPath: '/definitely/missing/gascity-dashboard-meminfo',
        totalMemoryBytes: undefined,
        availableMemoryBytes: undefined,
      });

      assert.equal(resources.memory.totalBytes > 0, true);
      assert.equal(resources.memory.availableBytes >= 0, true);
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0] ?? '',
      new RegExp(`^\\[${LOG_COMPONENT.snapshot}\\] resources.meminfo read failed: `),
    );
  });
});
