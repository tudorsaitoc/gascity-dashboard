import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LOG_COMPONENT, LOG_COMPONENTS } from '../src/logging.js';

describe('logging component vocabulary', () => {
  test('centralizes every backend log component name', () => {
    assert.deepEqual([...LOG_COMPONENTS].sort(), [
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
      LOG_COMPONENT.mailSend,
      LOG_COMPONENT.maintainer,
      LOG_COMPONENT.sessions,
      LOG_COMPONENT.snapshot,
      LOG_COMPONENT.sse,
      LOG_COMPONENT.runs,
    ].sort());
  });
});
