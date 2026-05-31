import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { validateGcSupervisorComponent } from '../src/gc-supervisor-schema-validator.js';

describe('gc supervisor OpenAPI schema validator', () => {
  test('accepts a valid generated component payload', () => {
    assert.equal(validateGcSupervisorComponent('Bead', validBead()), undefined);
  });

  test('rejects a missing required top-level property', () => {
    const issue = validateGcSupervisorComponent('Bead', {
      ...validBead(),
      title: undefined,
    });

    assert.deepEqual(issue, { path: ['title'], expected: 'present' });
  });

  test('rejects nested array items with useful paths', () => {
    const issue = validateGcSupervisorComponent('ListBodyBead', {
      items: [
        validBead('gc-ok'),
        {
          ...validBead('gc-bad'),
          created_at: 'not a timestamp',
        },
      ],
      total: 2,
    });

    assert.deepEqual(issue, { path: ['items', 1, 'created_at'], expected: 'date-time' });
  });

  test('keeps the nullable priority overlay for observed supervisor bead payloads', () => {
    assert.equal(
      validateGcSupervisorComponent('Bead', {
        ...validBead('gc-null-priority'),
        priority: null,
      }),
      undefined,
    );
  });

  test('rejects unsafe int64 numeric values instead of treating the format as an annotation', () => {
    const issue = validateGcSupervisorComponent('Bead', {
      ...validBead('gc-unsafe-priority'),
      priority: Number.MAX_SAFE_INTEGER + 1,
    });

    assert.deepEqual(issue, { path: ['priority'], expected: 'int64' });
  });
});

function validBead(id = 'gc-test') {
  return {
    id,
    title: 'Test bead',
    status: 'open',
    issue_type: 'task',
    created_at: '2026-05-30T12:00:00Z',
    metadata: {},
  };
}
