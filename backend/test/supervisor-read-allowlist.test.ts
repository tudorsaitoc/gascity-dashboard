import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { isAllowedReadPath } from '../src/routes/supervisor-read-allowlist.js';

describe('supervisor read allowlist', () => {
  test('allows the supervisor reads the dashboard SPA performs', () => {
    for (const path of [
      '/health',
      '/v0/cities',
      '/v0/city/test-city/agents',
      '/v0/city/test-city/beads',
      '/v0/city/test-city/bead/gascity-0001',
      '/v0/city/test-city/events',
      '/v0/city/test-city/events/stream',
      '/v0/city/test-city/formulas/feed',
      '/v0/city/test-city/formulas/my-formula',
      '/v0/city/test-city/health',
      '/v0/city/test-city/mail',
      '/v0/city/test-city/mail/thread/m1',
      '/v0/city/test-city/sessions',
      '/v0/city/test-city/session/s1/pending',
      '/v0/city/test-city/session/s1/stream',
      '/v0/city/test-city/session/s1/transcript',
      '/v0/city/test-city/status',
      '/v0/city/test-city/workflow/w1',
    ]) {
      assert.equal(isAllowedReadPath(path), true, `expected allow: ${path}`);
    }
  });

  test('denies side-effecting GETs and write/admin paths', () => {
    for (const path of [
      // agent prime is a state-changing GET — excluded on purpose.
      '/v0/city/test-city/agent/mayor/prime',
      '/v0/city/test-city/agent/pool/worker/prime',
      // mutations that happen to be reachable by GET shape must not slip in.
      '/v0/city/test-city/sling',
      '/v0/city/test-city/bead/gascity-0001/close',
      '/v0/city/test-city/agent/mayor/nudge',
      // unknown / out-of-surface paths.
      '/v0/city/test-city/agent/mayor',
      '/admin',
      '/v0/internal/secrets',
    ]) {
      assert.equal(isAllowedReadPath(path), false, `expected deny: ${path}`);
    }
  });

  test('anchors templates so a longer action suffix never matches a shorter read', () => {
    // `agent/{base}/prime` must not satisfy a generic two-segment agent read,
    // and trailing segments past a known read are rejected.
    assert.equal(isAllowedReadPath('/v0/city/test-city/beads/extra'), false);
    assert.equal(isAllowedReadPath('/v0/city/test-city/status/now'), false);
  });
});
