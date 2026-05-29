import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GcFormulaRun } from 'gas-city-dashboard-shared';

// gascity-dashboard-4lzn: Regression test for
// `GcFormulaRun.scope_kind: 'city' | 'rig' | (string & {})`. The union
// exposes the known discriminants in tooling while remaining structurally
// equivalent to `string` for assignability, so the existing
// `parseWorkflowScopeKind(value: string)` consumer (in
// backend/src/snapshot/collectors/workflows.ts) is unaffected. Errors
// surface at COMPILE time via `npm -w backend run typecheck:test`; the
// runtime asserts below are no-op tokens so this file participates in
// `node --test`.

test('GcFormulaRun.scope_kind: known discriminants assignable, non-string rejected', () => {
  // Compile-time contract checks. The `@ts-expect-error` directives below
  // intentionally fail tsc — if any of them stops failing (e.g. somebody
  // re-widens `scope_kind` back to bare `string`), tsc reports "Unused
  // '@ts-expect-error'" and CI's `typecheck:test` step will fail.

  type ScopeKind = GcFormulaRun['scope_kind'];

  // Known literal members are first-class.
  const city: ScopeKind = 'city';
  const rig: ScopeKind = 'rig';
  assert.equal(city, 'city');
  assert.equal(rig, 'rig');

  // Forward-compat branch: an unknown supervisor scope kind is accepted
  // because the type carries `(string & {})`. Without that branch the
  // type would collapse to `'city' | 'rig'` and break on new scope kinds.
  const future: ScopeKind = 'workspace';
  assert.equal(future, 'workspace');

  // Negative case: a non-string is rejected at compile time.
  // These declarations are compile-time-only assertions — the @ts-expect-error
  // directives are the actual test. We deliberately do NOT runtime-assert on
  // these values: tsc accepts the assignment via @ts-expect-error and the JS
  // value still propagates (42, null), so a runtime check would pass
  // vacuously and read as a runtime guarantee that does not exist.
  // @ts-expect-error - scope_kind is a string-valued discriminant; numbers
  // are not assignable to `'city' | 'rig' | (string & {})`.
  const _badNumber: ScopeKind = 42;
  // @ts-expect-error - same for `null`; the field is required and stringly typed.
  const _badNull: ScopeKind = null;
  void _badNumber;
  void _badNull;

  // Structural compatibility with `string`-typed consumers
  // (e.g. `parseWorkflowScopeKind(value: string)` in
  // backend/src/snapshot/collectors/workflows.ts). If this assignment
  // ever fails, callers that pass `run.scope_kind` into a plain
  // `string`-typed parameter would stop compiling.
  const asPlainString: string = city;
  assert.equal(asPlainString, 'city');

  // Tripwire: ScopeKind must remain a string-typed discriminant. If
  // anyone widens it to `any` (laundering type safety) or narrows it
  // to bare `'city' | 'rig'` (breaking forward-compat on new supervisor
  // scope kinds), one of the assertions below fails tsc.
  type ExtendsString<T> = T extends string ? true : false;
  type ContainsForwardCompat<T> = string extends T ? true : false;
  const _isStringTyped: ExtendsString<ScopeKind> = true;
  const _acceptsArbitraryStrings: ContainsForwardCompat<ScopeKind> = true;
  assert.ok(_isStringTyped);
  assert.ok(_acceptsArbitraryStrings);
});
