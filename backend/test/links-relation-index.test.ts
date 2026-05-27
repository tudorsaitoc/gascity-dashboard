import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { GcBead, GcSession } from 'gas-city-dashboard-shared';
import { makeNodeKey } from 'gas-city-dashboard-shared';
import { buildRelationIndex } from '../src/links/relation-index.js';

// R1 + RK1 unit tests for the backend relation index.

function bead(id: string, metadata: Record<string, unknown> = {}, over: Partial<GcBead> = {}): GcBead {
  return {
    id,
    title: `bead ${id}`,
    status: 'open',
    issue_type: 'task',
    priority: 2,
    created_at: '2026-05-20T00:00:00Z',
    updated_at: '2026-05-20T00:00:00Z',
    metadata,
    ...over,
  };
}

function session(id: string, over: Partial<GcSession> = {}): GcSession {
  return {
    id,
    template: 'tpl',
    state: 'active',
    created_at: '2026-05-20T00:00:00Z',
    attached: false,
    ...over,
  };
}

describe('buildRelationIndex (R1)', () => {
  test('forward edge and its inverse both resolve', () => {
    const beads: GcBead[] = [
      bead('root-1'),
      bead('child-1', { 'gc.parent_bead_id': 'root-1' }),
      bead('mem-1', { molecule_id: 'mol-1' }),
      bead('mem-2', { molecule_id: 'mol-1' }),
      bead('pr-bead', { 'pr_review.pr_number': '123' }),
      bead('sess-bead', { session_id: 'sess-abc' }),
    ];
    const index = buildRelationIndex(beads, [session('sess-abc')], 'ds-research');

    // children-of inverse
    assert.deepEqual(index.childrenOf.get('root-1'), ['child-1']);
    // members-of-molecule inverse
    assert.deepEqual(index.membersOfMolecule.get('mol-1'), ['mem-1', 'mem-2']);
    // beadsForPr inverse — the bead whose pr_review.pr_number === '123'
    assert.deepEqual(index.beadsForPr.get('123'), ['pr-bead']);
    // beadsForSession inverse
    assert.deepEqual(index.beadsForSession.get('sess-abc'), ['sess-bead']);
  });

  test('PR refs resolve from the deployed molecule evidence.* namespace', () => {
    // The real shapes the deployed molecule formulas write (mol-pr-from-issue,
    // mol-pr-iterate) — NOT pr_review.*, which is a different workflow family.
    const beads: GcBead[] = [
      // mol-pr-from-issue step 8: evidence.pr_url (+ artifact_path).
      bead('from-issue', {
        'evidence.pr_url': 'https://github.com/gastownhall/gascity/pull/742',
        'evidence.artifact_path': 'github-pr:gastownhall/gascity/742',
      }),
      // mol-pr-iterate step 3: evidence.pr_number only.
      bead('iterate', { 'evidence.pr_number': '42' }),
      // artifact_path alone (no pr_url / pr_number) still yields the number.
      bead('artifact-only', {
        'evidence.artifact_path': 'github-pr:gastownhall/gascity/123',
      }),
    ];
    const index = buildRelationIndex(beads, [], 'ds-research');

    // evidence.pr_url + matching artifact_path → number 742, url preserved.
    assert.deepEqual(index.beadsForPr.get('742'), ['from-issue']);
    assert.equal(
      index.beads.get('from-issue')?.prUrl,
      'https://github.com/gastownhall/gascity/pull/742',
    );
    // evidence.pr_number → number 42.
    assert.deepEqual(index.beadsForPr.get('42'), ['iterate']);
    // evidence.artifact_path github-pr: form → parsed number 123.
    assert.deepEqual(index.beadsForPr.get('123'), ['artifact-only']);
    assert.equal(index.beads.get('artifact-only')?.prNumber, '123');
  });

  test('PR ref priority: evidence.* wins, pr_review.* is fallback', () => {
    const beads: GcBead[] = [
      // evidence.pr_number should win over a stale pr_review.pr_number.
      bead('evidence-wins', {
        'evidence.pr_number': '500',
        'pr_review.pr_number': '999',
      }),
      // pr_review.* still resolves when no evidence.* key is present (the
      // other workflow family relies on it).
      bead('review-fallback', {
        'pr_review.pr_number': '300',
        'pr_review.pr_url': 'https://github.com/gastownhall/gascity/pull/300',
      }),
    ];
    const index = buildRelationIndex(beads, [], 'ds-research');

    assert.deepEqual(index.beadsForPr.get('500'), ['evidence-wins']);
    assert.equal(index.beadsForPr.has('999'), false);
    assert.deepEqual(index.beadsForPr.get('300'), ['review-fallback']);
    assert.equal(
      index.beads.get('review-fallback')?.prUrl,
      'https://github.com/gastownhall/gascity/pull/300',
    );
  });

  test('RK1: superseded retry beads are excluded from reverse lookups', () => {
    // Two attempts of the same step in the same molecule: attempt 1 is a
    // dead retry, attempt 2 is live. Both also reference the same PR.
    const beads: GcBead[] = [
      bead('retry-old', {
        molecule_id: 'mol-x',
        'gc.step_id': 'implement',
        'gc.attempt': '1',
        'pr_review.pr_number': '99',
      }),
      bead('retry-new', {
        molecule_id: 'mol-x',
        'gc.step_id': 'implement',
        'gc.attempt': '2',
        'pr_review.pr_number': '99',
      }),
    ];
    const index = buildRelationIndex(beads, [], 'ds-research');

    // Dead retry must NOT appear in beadsForPr.
    assert.deepEqual(
      index.beadsForPr.get('99'),
      ['retry-new'],
      'superseded retry must not surface as a peer of the live edge',
    );
    assert.equal(index.allBeads.get('retry-old')?.superseded, true);
    assert.equal(index.beads.has('retry-old'), false);
    assert.equal(index.beads.has('retry-new'), true);
  });

  test('RK1: distinct-scope beads of the same molecule do not collide on scope', () => {
    const beads: GcBead[] = [
      bead('rig-a-bead', { molecule_id: 'mol-1', 'gc.scope_ref': 'rig-a' }),
      bead('rig-b-bead', { molecule_id: 'mol-2', 'gc.scope_ref': 'rig-b' }),
    ];
    const index = buildRelationIndex(beads, [], 'ds-research');
    // The scope token encodes kind+ref (defaulting to `rig` kind when only
    // a scope_ref is present) so distinct rigs never collide.
    assert.equal(index.beads.get('rig-a-bead')?.scope, 'rig:rig-a');
    assert.equal(index.beads.get('rig-b-bead')?.scope, 'rig:rig-b');
    // Distinct molecules don't merge.
    assert.deepEqual(index.membersOfMolecule.get('mol-1'), ['rig-a-bead']);
    assert.deepEqual(index.membersOfMolecule.get('mol-2'), ['rig-b-bead']);
  });

  test('OQ#1: same bare id under different scope_kind yields distinct node keys', () => {
    // The actual cross-scope collision case the namespaced key prevents: a
    // city-scoped bead and a rig-scoped bead sharing the SAME bare id and
    // the SAME bare scope_ref. The bare id alone would collide; the scope
    // token (kind+ref) keeps them distinct.
    const cityBead = bead('shared-id', {
      'gc.scope_kind': 'city',
      'gc.scope_ref': 'overlap',
    });
    const rigBead = bead('shared-id', {
      'gc.scope_kind': 'rig',
      'gc.scope_ref': 'overlap',
    });
    const cityIndex = buildRelationIndex([cityBead], [], 'ds-research');
    const rigIndex = buildRelationIndex([rigBead], [], 'ds-research');
    const cityScope = cityIndex.beads.get('shared-id')?.scope;
    const rigScope = rigIndex.beads.get('shared-id')?.scope;
    assert.equal(cityScope, 'city:overlap');
    assert.equal(rigScope, 'rig:overlap');
    // Distinct scope tokens → distinct namespaced node keys for the same
    // bare id, so the two beads never collide in the link view.
    assert.notEqual(cityScope, rigScope);
    assert.notEqual(
      makeNodeKey('bead', 'shared-id', cityScope ?? ''),
      makeNodeKey('bead', 'shared-id', rigScope ?? ''),
    );
  });

  test('a bead with only one attempt is never superseded', () => {
    const beads: GcBead[] = [
      bead('solo', { molecule_id: 'm', 'gc.step_id': 's', 'gc.attempt': '1' }),
    ];
    const index = buildRelationIndex(beads, [], 'c');
    assert.equal(index.allBeads.get('solo')?.superseded, false);
    assert.equal(index.beads.has('solo'), true);
  });
});
