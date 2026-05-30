// gascity-dashboard-brx: unit coverage for the shared redaction-test
// wire-error narrowing helper. The helper replaces ~9 ad-hoc
// `res.body.details as { name?: string; ... }` casts across the
// redaction-layer tests (agents-prime, beads-nudge, mail-send,
// maintainer-sling, git-commits). The casts silenced the type system
// without validating shape — a wire change that flipped `details` from
// object to string would have slipped through as a runtime
// `cannot read properties of string` deep inside an assertion.
//
// The helper has two entry points:
//   - assertWireDetails(v): throws on undefined/null/non-object/array,
//     used by sites that pin "details MUST be present".
//   - isWireDetails(v): boolean guard, used by the one tolerant site
//     in agents-prime.test.ts that asserts "if details is present,
//     it must not carry raw stderr" (404 not-configured wire shape).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertWireDetails,
  isWireDetails,
  type WireDetails,
} from './helpers/wire.js';

describe('assertWireDetails', () => {
  test('narrows a plain object so optional fields are readable', () => {
    const v: unknown = { name: 'NonZeroExit' };
    assertWireDetails(v);
    // After the assertion, TS knows v is WireDetails. Read fields directly.
    assert.equal(v.name, 'NonZeroExit');
    assert.equal(v.message, undefined);
    assert.equal(v.stderr, undefined);
  });

  test('accepts an empty object — optional fields are all absent', () => {
    const v: unknown = {};
    assertWireDetails(v);
    assert.equal(v.name, undefined);
  });

  test('throws on undefined', () => {
    assert.throws(() => assertWireDetails(undefined), /wire details/i);
  });

  test('throws on null', () => {
    assert.throws(() => assertWireDetails(null), /wire details/i);
  });

  test('throws on a primitive', () => {
    assert.throws(() => assertWireDetails('NonZeroExit'), /wire details/i);
    assert.throws(() => assertWireDetails(42), /wire details/i);
    assert.throws(() => assertWireDetails(true), /wire details/i);
  });

  test('throws on an array (typeof array === "object" trap)', () => {
    assert.throws(() => assertWireDetails([]), /wire details/i);
    assert.throws(
      () => assertWireDetails([{ name: 'NonZeroExit' }]),
      /wire details/i,
    );
  });
});

describe('isWireDetails', () => {
  test('returns true for a plain object', () => {
    const v: unknown = { name: 'NonZeroExit', stderr: 'foo' };
    assert.equal(isWireDetails(v), true);
    if (isWireDetails(v)) {
      const narrowed: WireDetails = v;
      assert.equal(narrowed.name, 'NonZeroExit');
    }
  });

  test('returns true for an empty object', () => {
    assert.equal(isWireDetails({}), true);
  });

  test('returns false for undefined / null / primitive / array', () => {
    assert.equal(isWireDetails(undefined), false);
    assert.equal(isWireDetails(null), false);
    assert.equal(isWireDetails('x'), false);
    assert.equal(isWireDetails(42), false);
    assert.equal(isWireDetails([]), false);
    assert.equal(isWireDetails([{ name: 'x' }]), false);
  });
});
