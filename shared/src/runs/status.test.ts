import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  isBlockedStatus,
  isClosedStatus,
  isFailedStatus,
  isInFlightStatus,
  isOpenStatus,
  isResolvedStatus,
  isSkippedStatus,
  presentationStatus,
} from './status.js';
import type { RunSnapshotBead } from '../run-snapshot.js';

// status.ts is the single home for the raw bead-status vocabulary. Phase, lane,
// and stage derivation read TWO vocabularies through these predicates: bd ledger
// (open/in_progress/closed) and supervisor wire (pending/active/completed). The
// predicates normalize (trim + lowercase) so a cased or padded wire spelling
// classifies the same way presentationStatus renders it — closing the M2 drift
// class where a status could be visible to the node graph yet invisible to phase
// derivation.

describe('isInFlightStatus', () => {
  for (const s of ['in_progress', 'active', 'running']) {
    test(`'${s}' is in flight`, () => assert.equal(isInFlightStatus(s), true));
  }
  for (const s of [
    'open',
    'pending',
    'ready',
    'closed',
    'completed',
    'done',
    'failed',
    'skipped',
  ]) {
    test(`'${s}' is not in flight`, () => assert.equal(isInFlightStatus(s), false));
  }
  test('normalizes casing and surrounding whitespace', () => {
    assert.equal(isInFlightStatus('Active'), true);
    assert.equal(isInFlightStatus(' running '), true);
    assert.equal(isInFlightStatus('IN_PROGRESS'), true);
  });
});

describe('isClosedStatus', () => {
  for (const s of ['closed', 'completed', 'done']) {
    test(`'${s}' is closed`, () => assert.equal(isClosedStatus(s), true));
  }
  for (const s of ['failed', 'skipped', 'in_progress', 'active', 'pending', 'open', 'ready']) {
    test(`'${s}' is not closed`, () => assert.equal(isClosedStatus(s), false));
  }
  test('normalizes casing and surrounding whitespace', () => {
    assert.equal(isClosedStatus(' Completed '), true);
    assert.equal(isClosedStatus('DONE'), true);
  });
});

describe('isResolvedStatus', () => {
  for (const s of ['closed', 'completed', 'done', 'failed', 'skipped']) {
    test(`'${s}' is resolved`, () => assert.equal(isResolvedStatus(s), true));
  }
  for (const s of ['in_progress', 'active', 'running', 'pending', 'open', 'ready', 'blocked']) {
    test(`'${s}' is not resolved`, () => assert.equal(isResolvedStatus(s), false));
  }
  test('normalizes casing and surrounding whitespace', () => {
    assert.equal(isResolvedStatus('Failed'), true);
    assert.equal(isResolvedStatus(' skipped'), true);
  });
});

describe('isFailedStatus / isSkippedStatus — the failed and skipped arms of resolved', () => {
  test("only 'failed' is a failed status", () => {
    assert.equal(isFailedStatus('failed'), true);
    assert.equal(isFailedStatus('Failed'), true);
    assert.equal(isFailedStatus(' failed '), true);
    for (const s of ['skipped', 'closed', 'completed', 'done', 'active', 'pending', 'open']) {
      assert.equal(isFailedStatus(s), false);
    }
  });

  test("only 'skipped' is a skipped status", () => {
    assert.equal(isSkippedStatus('skipped'), true);
    assert.equal(isSkippedStatus('SKIPPED'), true);
    assert.equal(isSkippedStatus(' skipped'), true);
    for (const s of ['failed', 'closed', 'completed', 'done', 'active', 'pending', 'open']) {
      assert.equal(isSkippedStatus(s), false);
    }
  });

  test('resolved is exactly closed OR failed OR skipped', () => {
    for (const s of ['closed', 'completed', 'done', 'failed', 'skipped']) {
      assert.equal(
        isResolvedStatus(s),
        isClosedStatus(s) || isFailedStatus(s) || isSkippedStatus(s),
      );
      assert.equal(isResolvedStatus(s), true);
    }
  });
});

describe('isOpenStatus / isBlockedStatus — frontend filter/tone helpers', () => {
  test("only 'open' is an open status, normalized for cased / padded wire spellings", () => {
    assert.equal(isOpenStatus('open'), true);
    assert.equal(isOpenStatus('Open'), true);
    assert.equal(isOpenStatus(' open '), true);
    for (const s of [
      'blocked',
      'in_progress',
      'active',
      'closed',
      'completed',
      'ready',
      'pending',
    ]) {
      assert.equal(isOpenStatus(s), false);
    }
  });

  test("only 'blocked' is a blocked status, normalized for cased / padded wire spellings", () => {
    assert.equal(isBlockedStatus('blocked'), true);
    assert.equal(isBlockedStatus('Blocked'), true);
    assert.equal(isBlockedStatus(' blocked '), true);
    for (const s of ['open', 'in_progress', 'active', 'closed', 'completed', 'ready', 'pending']) {
      assert.equal(isBlockedStatus(s), false);
    }
  });
});

describe('presentationStatus — built on the shared vocabulary predicates', () => {
  function bead(status: string, metadata: Record<string, string> = {}): RunSnapshotBead {
    return { id: 'b', title: 'b', status, kind: 'step', metadata };
  }

  test('maps every closed spelling to completed', () => {
    assert.equal(presentationStatus(bead('closed')), 'completed');
    assert.equal(presentationStatus(bead('completed')), 'completed');
    assert.equal(presentationStatus(bead('done')), 'completed');
  });

  test('gc.outcome refines a closed step to failed / skipped', () => {
    assert.equal(presentationStatus(bead('closed', { 'gc.outcome': 'fail' })), 'failed');
    assert.equal(presentationStatus(bead('completed', { 'gc.outcome': 'failed' })), 'failed');
    assert.equal(presentationStatus(bead('done', { 'gc.outcome': 'skipped' })), 'skipped');
  });

  test('maps every in-flight spelling to active', () => {
    assert.equal(presentationStatus(bead('in_progress')), 'active');
    assert.equal(presentationStatus(bead('active')), 'active');
    assert.equal(presentationStatus(bead('running')), 'active');
  });

  test('keeps the blocked / ready / failed / skipped / pending arms', () => {
    assert.equal(presentationStatus(bead('blocked')), 'blocked');
    assert.equal(presentationStatus(bead('ready')), 'ready');
    assert.equal(presentationStatus(bead('failed')), 'failed');
    assert.equal(presentationStatus(bead('skipped')), 'skipped');
    assert.equal(presentationStatus(bead('')), 'pending');
    assert.equal(presentationStatus(bead('something-unknown')), 'pending');
  });

  test('classifies cased / padded wire spellings the same as their canonical form', () => {
    assert.equal(presentationStatus(bead(' Completed ')), 'completed');
    assert.equal(presentationStatus(bead('ACTIVE')), 'active');
  });
});
