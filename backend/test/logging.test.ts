import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  LOG_COMPONENT,
  LOG_COMPONENTS,
  logInfo,
  recordCounter,
  recordTimer,
  runWithLogContext,
  sanitizeForLog,
} from '../src/logging.js';

describe('logging component vocabulary', () => {
  test('centralizes every backend log component name', () => {
    assert.deepEqual(
      [...LOG_COMPONENTS].sort(),
      [
        LOG_COMPONENT.admin,
        LOG_COMPONENT.adminAudit,
        LOG_COMPONENT.agents,
        LOG_COMPONENT.beads,
        LOG_COMPONENT.builds,
        LOG_COMPONENT.client,
        LOG_COMPONENT.doltNoms,
        LOG_COMPONENT.git,
        LOG_COMPONENT.health,
        LOG_COMPONENT.links,
        LOG_COMPONENT.mail,
        LOG_COMPONENT.maintainer,
        LOG_COMPONENT.metrics,
        LOG_COMPONENT.sessions,
        LOG_COMPONENT.snapshot,
        LOG_COMPONENT.sse,
        LOG_COMPONENT.runs,
      ].sort(),
    );
  });
});

describe('request context logging', () => {
  test('adds request_id to log lines when a request context is active', () => {
    const lines = captureConsoleInfo(() => {
      runWithLogContext({ requestId: 'req-test-1' }, () => {
        logInfo(LOG_COMPONENT.admin, 'handled');
      });
    });

    assert.deepEqual(lines, ['[admin] request_id="req-test-1" handled']);
  });
});

describe('metric logging', () => {
  test('emits counter and timer metrics as key-value log lines', () => {
    const lines = captureConsoleInfo(() => {
      recordCounter('supervisor.request', { operation: 'getStatus', ok: true });
      recordTimer('supervisor.request.latency', 12, { operation: 'getStatus' });
    });

    assert.deepEqual(lines, [
      '[metrics] metric name="supervisor.request" kind="counter" operation="getStatus" ok=true',
      '[metrics] metric name="supervisor.request.latency" kind="timer" duration_ms=12 operation="getStatus"',
    ]);
  });
});

describe('sanitizeForLog', () => {
  // izgc Phase 4 security-reviewer finding: supervisor-controlled
  // `partial_errors[]` strings interpolated into operator log lines must
  // not be able to inject forged `[component] message` lines via embedded
  // newlines. Defensive even though the supervisor is loopback-trusted.
  test('replaces LF with space', () => {
    assert.equal(sanitizeForLog('foo\nbar'), 'foo bar');
  });
  test('replaces CR with space', () => {
    assert.equal(sanitizeForLog('foo\rbar'), 'foo bar');
  });
  test('replaces CRLF with two spaces', () => {
    assert.equal(sanitizeForLog('foo\r\nbar'), 'foo  bar');
  });
  test('handles a forged-log-line attempt', () => {
    const hostile = 'rig/foo down\n[admin] CRITICAL auth bypass at 2026-05-28';
    const out = sanitizeForLog(hostile);
    assert.doesNotMatch(out, /\n/);
    assert.match(out, /\[admin\] CRITICAL/); // content preserved, line break removed
  });
  test('passes through clean strings', () => {
    assert.equal(sanitizeForLog('rig/foo down'), 'rig/foo down');
  });
});

function captureConsoleInfo(fn: () => void): string[] {
  const original = console.info;
  const lines: string[] = [];
  console.info = (message?: unknown, ...rest: unknown[]) => {
    lines.push([message, ...rest].map(String).join(' '));
  };
  try {
    fn();
    return lines;
  } finally {
    console.info = original;
  }
}
