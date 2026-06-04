import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  fromRequestScope,
  fromFeedScope,
  fromRootMetadataScope,
  fromSnapshotScope,
  fromStoreRef,
  parseRunScopeKind,
} from '../src/lib/run-scope.js';

describe('run scope helpers', () => {
  test('parseRunScopeKind accepts only city and rig', () => {
    assert.equal(parseRunScopeKind('city'), 'city');
    assert.equal(parseRunScopeKind('rig'), 'rig');
    assert.equal(parseRunScopeKind('team'), null);
    assert.equal(parseRunScopeKind(undefined), null);
  });

  test('fromRequestScope keeps absent scope optional but rejects half-scope', () => {
    assert.deepEqual(fromRequestScope({}), { ok: true });
    assert.deepEqual(fromRequestScope({ scope_kind: 'city' }), {
      ok: false,
      error: 'scope kind and scope ref are required together',
    });
    assert.deepEqual(fromRequestScope({ scope_ref: 'example-city' }), {
      ok: false,
      error: 'scope kind and scope ref are required together',
    });
  });

  test('fromRequestScope validates kind and ref with route error wording', () => {
    assert.deepEqual(fromRequestScope({ scope_kind: 'project', scope_ref: 'abc' }), {
      ok: false,
      error: 'invalid scope kind',
    });
    assert.deepEqual(fromRequestScope({ scope_kind: 'city', scope_ref: '../bad' }), {
      ok: false,
      error: 'invalid scope ref',
    });
    assert.deepEqual(fromRequestScope({ scope_kind: 'rig', scope_ref: 'rig-a' }), {
      ok: true,
      scope: { scopeKind: 'rig', scopeRef: 'rig-a' },
    });
  });

  test('fromStoreRef parses only complete city/rig store refs', () => {
    assert.deepEqual(fromStoreRef('city:demo'), { scopeKind: 'city', scopeRef: 'demo' });
    assert.deepEqual(fromStoreRef('rig:worker-a'), { scopeKind: 'rig', scopeRef: 'worker-a' });
    assert.equal(fromStoreRef('project:demo'), null);
    assert.equal(fromStoreRef('city:'), null);
  });

  test('fromRootMetadataScope applies SCOPE_REF_RE to bead metadata scope', () => {
    assert.deepEqual(
      fromRootMetadataScope({
        'gc.scope_kind': 'city',
        'gc.scope_ref': 'tic-tac-toe-app',
        'gc.root_store_ref': 'city:tic-tac-toe-app',
      }),
      {
        scopeKind: 'city',
        scopeRef: 'tic-tac-toe-app',
        rootStoreRef: 'city:tic-tac-toe-app',
      },
    );
    assert.equal(
      fromRootMetadataScope({
        'gc.scope_kind': 'city',
        'gc.scope_ref': '../bad',
      }),
      null,
    );
  });

  test('fromFeedScope applies SCOPE_REF_RE and preserves root store fallback', () => {
    assert.deepEqual(
      fromFeedScope({
        scope_kind: 'rig',
        scope_ref: 'worker-a',
        root_store_ref: 'rig:worker-a',
      }),
      {
        scopeKind: 'rig',
        scopeRef: 'worker-a',
        rootStoreRef: 'rig:worker-a',
      },
    );
    assert.deepEqual(fromFeedScope({ scope_kind: 'city', scope_ref: 'demo' }), {
      scopeKind: 'city',
      scopeRef: 'demo',
      rootStoreRef: 'city:demo',
    });
    assert.equal(fromFeedScope({ scope_kind: 'city', scope_ref: '../bad' }), null);
  });

  test('fromSnapshotScope returns null instead of throwing so callers keep their own contracts', () => {
    assert.deepEqual(fromSnapshotScope({ scope_kind: 'city', scope_ref: 'demo' }), {
      scopeKind: 'city',
      scopeRef: 'demo',
    });
    assert.equal(fromSnapshotScope({ scope_kind: 'city', scope_ref: '' }), null);
    assert.equal(fromSnapshotScope({ scope_kind: 'bad', scope_ref: 'demo' }), null);
  });
});
