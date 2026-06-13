import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { mapRunPhase, stageProgress, stepIdPhase, type RunIssue } from './phaseMapping.js';

// gascity-dashboard-q3p1: phase is derived from the run's CURRENT step
// (structured-first), not from a keyword scan over title+description+metadata.
// The old scan collapsed almost every real formula run onto 'approval' because
// broad needles like 'gate' (order:gate-sweep, "ship gate") and 'human' (the
// ubiquitous summary_for_human metadata key) matched incidental text in some
// bead of the group.

function root(overrides: Partial<RunIssue> & Pick<RunIssue, 'id'>): RunIssue {
  return {
    title: 'run root',
    status: 'open',
    issue_type: 'molecule',
    updated_at: '2026-06-06T00:00:00.000Z',
    metadata: { 'gc.formula_contract': 'graph.v2', 'gc.kind': 'run' },
    ...overrides,
  };
}

function step(
  id: string,
  stepId: string,
  status: string,
  overrides: Partial<RunIssue> = {},
): RunIssue {
  return {
    id,
    title: 'step',
    status,
    issue_type: 'task',
    updated_at: '2026-06-06T00:01:00.000Z',
    metadata: { 'gc.kind': 'step', 'gc.step_id': stepId },
    ...overrides,
  };
}

describe('mapRunPhase — structured derivation from the current step (gascity-dashboard-q3p1)', () => {
  test('an in_progress implementation step → implementation', () => {
    const phase = mapRunPhase([
      root({ id: 'r1' }),
      step('r1-s1', 'implement-change', 'in_progress'),
    ]);
    assert.equal(phase.phase, 'implementation');
  });

  test('an in_progress review step → review (with a review round)', () => {
    const phase = mapRunPhase([
      root({ id: 'r2' }),
      step('r2-s1', 'code-review-loop', 'in_progress'),
    ]);
    assert.equal(phase.phase, 'review');
    assert.ok(phase.reviewRound !== null && phase.reviewRound >= 1);
  });

  test('an in_progress approval/gate step → approval (true positive still works)', () => {
    const phase = mapRunPhase([root({ id: 'r3' }), step('r3-s1', 'human-approval', 'in_progress')]);
    assert.equal(phase.phase, 'approval');
  });

  test('an in_progress finalize step → finalization', () => {
    const phase = mapRunPhase([
      root({ id: 'r4' }),
      step('r4-s1', 'merge-and-finalize', 'in_progress'),
    ]);
    assert.equal(phase.phase, 'finalization');
  });

  test('phase advances as the active step advances (graph.v2 progression)', () => {
    const base = [root({ id: 'rp' })];
    // 1. implementation in progress, later steps not yet started.
    const atImpl = mapRunPhase([
      ...base,
      step('rp-s1', 'implement-change', 'in_progress'),
      step('rp-s2', 'code-review-loop', 'open'),
      step('rp-s3', 'human-approval', 'open'),
    ]);
    assert.equal(atImpl.phase, 'implementation');

    // 2. implementation closed, review now in progress.
    const atReview = mapRunPhase([
      ...base,
      step('rp-s1', 'implement-change', 'closed'),
      step('rp-s2', 'code-review-loop', 'in_progress', {
        updated_at: '2026-06-06T01:00:00.000Z',
      }),
      step('rp-s3', 'human-approval', 'open'),
    ]);
    assert.equal(atReview.phase, 'review');

    // 3. review closed, approval now in progress.
    const atApproval = mapRunPhase([
      ...base,
      step('rp-s1', 'implement-change', 'closed'),
      step('rp-s2', 'code-review-loop', 'closed'),
      step('rp-s3', 'human-approval', 'in_progress', {
        updated_at: '2026-06-06T02:00:00.000Z',
      }),
    ]);
    assert.equal(atApproval.phase, 'approval');
  });

  test('falls back to latest advanced step when nothing is in_progress', () => {
    const phase = mapRunPhase([
      root({ id: 'rl' }),
      step('rl-s1', 'implement-change', 'closed', { updated_at: '2026-06-06T00:01:00.000Z' }),
      step('rl-s2', 'code-review-loop', 'closed', { updated_at: '2026-06-06T02:00:00.000Z' }),
    ]);
    // Latest advanced step is the review-loop, so the run reads as review.
    assert.equal(phase.phase, 'review');
  });
});

describe('mapRunPhase — incidental text never forces approval (the core regression)', () => {
  test('a summary_for_human metadata key does NOT classify the run as approval', () => {
    const phase = mapRunPhase([
      root({
        id: 'h1',
        metadata: {
          'gc.formula_contract': 'graph.v2',
          'gc.kind': 'run',
          summary_for_human: 'the run summary that operators read',
        },
      }),
      step('h1-s1', 'implement-change', 'in_progress', {
        metadata: {
          'gc.kind': 'step',
          'gc.step_id': 'implement-change',
          summary_for_human: 'implementing the change',
        },
      }),
    ]);
    assert.notEqual(phase.phase, 'approval');
    assert.equal(phase.phase, 'implementation');
  });

  test('a "gate" reference (order:gate-sweep dep / "Run BLOCKING gates" desc) does NOT classify as approval', () => {
    const phase = mapRunPhase([
      root({
        id: 'g1',
        description: 'Run BLOCKING gates before merge; order:gate-sweep dependency',
      }),
      step('g1-s1', 'implement-change', 'in_progress', {
        title: 'Run BLOCKING gates',
        description: 'order:gate-sweep — ship gate',
      }),
    ]);
    assert.notEqual(phase.phase, 'approval');
    assert.equal(phase.phase, 'implementation');
  });

  test('a run with summary_for_human but NO step beads stays conservative, not approval', () => {
    const phase = mapRunPhase([
      root({
        id: 'n1',
        title: 'A generic run',
        metadata: {
          'gc.kind': 'run',
          summary_for_human: 'a human-readable summary that mentions a gate',
        },
      }),
    ]);
    // No step identity, and the summary_for_human value (with its 'gate'/'human'
    // text) is no longer scanned — so the fallback stays conservative.
    assert.notEqual(phase.phase, 'approval');
    assert.equal(phase.phase, 'active');
  });
});

describe('mapRunPhase — deterministic current-step pick without updated_at (gascity-dashboard Major 3)', () => {
  // The run-detail snapshot adapter (formula-run.ts fromRunSnapshotBead) sets
  // every bead updated_at=''. With no in_progress step the old timestamp-based
  // pick was input-ORDER-dependent (Date.parse('') === NaN). The fallback must
  // be deterministic and pick the furthest-advanced stage, and a summary-context
  // version of the same run (real timestamps) must agree with the detail context.

  function snapshotStep(stepId: string, status: string): RunIssue {
    // Detail-snapshot shape: no per-bead timestamp.
    return {
      id: `step-${stepId}`,
      title: 'step',
      status,
      issue_type: 'task',
      updated_at: '',
      metadata: { 'gc.kind': 'step', 'gc.step_id': stepId },
    };
  }

  test('no in_progress step + empty updated_at → deterministic furthest stage, order-independent', () => {
    const forward = mapRunPhase([
      root({ id: 'd1', updated_at: '' }),
      snapshotStep('implement-change', 'closed'),
      snapshotStep('code-review-loop', 'closed'),
    ]);
    const reversed = mapRunPhase([
      root({ id: 'd1', updated_at: '' }),
      snapshotStep('code-review-loop', 'closed'),
      snapshotStep('implement-change', 'closed'),
    ]);
    // Furthest advanced of the two closed steps is the review loop.
    assert.equal(forward.phase, 'review');
    // Input order must not change the result.
    assert.equal(reversed.phase, forward.phase);
  });

  test('summary-context (real timestamps) and detail-context (empty) of the same run agree', () => {
    const detail = mapRunPhase([
      root({ id: 'd2', updated_at: '' }),
      snapshotStep('implement-change', 'closed'),
      snapshotStep('code-review-loop', 'closed'),
    ]);
    const summary = mapRunPhase([
      root({ id: 'd2' }),
      step('d2-s1', 'implement-change', 'closed', { updated_at: '2026-06-06T00:01:00.000Z' }),
      step('d2-s2', 'code-review-loop', 'closed', { updated_at: '2026-06-06T02:00:00.000Z' }),
    ]);
    assert.equal(detail.phase, summary.phase);
  });
});

describe('mapRunPhase — status branches remain authoritative', () => {
  test('any blocked bead → blocked, regardless of step identity', () => {
    const phase = mapRunPhase([root({ id: 'b1' }), step('b1-s1', 'implement-change', 'blocked')]);
    assert.equal(phase.phase, 'blocked');
  });

  test('all closed → complete, regardless of step identity', () => {
    const phase = mapRunPhase([
      root({ id: 'c1', status: 'closed' }),
      step('c1-s1', 'implement-change', 'closed'),
    ]);
    assert.equal(phase.phase, 'complete');
  });
});

describe('mapRunPhase — tightened keyword fallback (no structured steps)', () => {
  test('a do-work title (no gc.step_id) still reads as implementation', () => {
    const phase = mapRunPhase([
      root({ id: 'f1', title: 'mol-do-work' }),
      {
        id: 'f1-c1',
        title: 'Do the work',
        status: 'in_progress',
        issue_type: 'task',
        updated_at: '2026-06-06T00:02:00.000Z',
        metadata: { molecule_id: 'f1' },
      },
    ]);
    assert.equal(phase.phase, 'implementation');
  });

  test('a description-only "gate"/"human"/"merge" mention does NOT reach approval/finalization in the fallback', () => {
    const phase = mapRunPhase([
      root({
        id: 'f2',
        title: 'A generic run',
        description: 'review the gate, ask a human, then merge and report',
      }),
    ]);
    // Description is no longer scanned and the title carries no step signal →
    // conservative active. The incidental 'gate'/'human'/'merge' words in the
    // description never force a late phase.
    assert.notEqual(phase.phase, 'approval');
    assert.notEqual(phase.phase, 'finalization');
    assert.equal(phase.phase, 'active');
  });
});

// M2 audit (run ga-wisp-x0tank): the run-detail page feeds phase derivation
// SUPERVISOR WIRE statuses (pending/active/completed via fromRunSnapshotBead),
// not bd ledger statuses (open/in_progress/closed). Two layered defects:
//   (1) structuredPhase matched only status==='in_progress', so the in-flight
//       step detection could NEVER fire on the run-detail page — a live
//       'active' bead was invisible to it.
//   (2) the no-in-flight fallback (furthestStageStepId) ranked ALL materialized
//       steps, including pending/unstarted shells. graph.v2 runs materialize
//       the full DAG at pour time, so a pending 'cleanup-worktree' wisp drove
//       phase='finalization' (ladder: Intake/Implementation/Review/Approval
//       all complete) for the run's ENTIRE life while it was mid-review.
describe('mapRunPhase — supervisor wire status vocabulary (M2)', () => {
  function wireStep(stepId: string, status: string, overrides: Partial<RunIssue> = {}): RunIssue {
    // Run-detail snapshot shape: wire statuses, no per-bead timestamp.
    return {
      id: `step-${stepId}`,
      title: 'step',
      status,
      issue_type: 'task',
      updated_at: '',
      metadata: { 'gc.kind': 'step', 'gc.step_id': stepId },
      ...overrides,
    };
  }

  // Captured graph.v2 retry shape (live mol-adopt-pr-v2 review loop, root
  // gd-wisp-0ye1): a retried step's WORK bead carries an attempt-SUFFIXED
  // gc.step_id / step_ref (apply-fixes.attempt.N), while gc.attempt mirrors the
  // review-loop ITERATION (6) — identical across every attempt of the iteration,
  // so it cannot discriminate per-step retries. The BASE step id lives only on the
  // gc.kind=retry / scope-check latch beads. These helpers reproduce that shape so
  // the cohorting fix is pinned to real metadata, not an invented base-id+gc.attempt
  // model.
  const RETRY_ITERATION = 6;
  function loopRefs(stepId: string): { step_ref: string; scope_ref: string } {
    const scope_ref = `mol-adopt-pr-v2.review-loop.iteration.${RETRY_ITERATION}`;
    return { step_ref: `${scope_ref}.${stepId}`, scope_ref };
  }
  function workAttempt(step: string, attempt: number, status: string): RunIssue {
    const stepId = `${step}.attempt.${attempt}`;
    const refs = loopRefs(stepId);
    return {
      id: `work-${stepId}`,
      title: 'step',
      status,
      issue_type: 'task',
      updated_at: '',
      step_ref: refs.step_ref,
      scope_ref: refs.scope_ref,
      metadata: {
        'gc.kind': 'work',
        'gc.step_id': stepId,
        'gc.attempt': String(RETRY_ITERATION),
        'gc.step_ref': refs.step_ref,
        'gc.scope_ref': refs.scope_ref,
      },
    };
  }
  function retryLatch(step: string, status: string): RunIssue {
    const refs = loopRefs(step);
    return {
      id: `retry-${step}`,
      title: 'retry latch',
      status,
      issue_type: 'task',
      updated_at: '',
      step_ref: refs.step_ref,
      scope_ref: refs.scope_ref,
      metadata: {
        'gc.kind': 'retry',
        'gc.step_id': step,
        'gc.attempt': String(RETRY_ITERATION),
        'gc.step_ref': refs.step_ref,
        'gc.scope_ref': refs.scope_ref,
      },
    };
  }

  test("an 'active' (wire) step drives the structured phase, exactly like 'in_progress'", () => {
    const phase = mapRunPhase([
      root({ id: 'w1', updated_at: '', status: 'pending' }),
      wireStep('implement-change', 'active'),
      wireStep('cleanup-worktree', 'pending'),
    ]);
    assert.equal(phase.phase, 'implementation');
  });

  test('fallback ignores materialized pending shells — only ADVANCED steps rank', () => {
    // Nothing in flight; implementation completed; the post-review wave
    // (approval gate, finalize, cleanup) is materialized but unstarted.
    const phase = mapRunPhase([
      root({ id: 'w2', updated_at: '', status: 'pending' }),
      wireStep('implement-change', 'completed'),
      wireStep('human-approval', 'pending'),
      wireStep('finalize', 'pending'),
      wireStep('cleanup-worktree', 'pending'),
    ]);
    assert.equal(phase.phase, 'implementation');
  });

  test('ga-wisp-x0tank shape: review wave done, synthesize active, post-review wave pending → review', () => {
    // Mirrors the captured supervisor payload for ga-wisp-x0tank: the review
    // pipeline is mid-flight, yet the deployed pipeline derived 'finalization'.
    const issues = [
      root({ id: 'ga-wisp-x0tank', updated_at: '', status: 'pending' }),
      wireStep('preflight', 'completed'),
      wireStep('rebase-check', 'completed'),
      wireStep('pre-review-ci', 'completed'),
      wireStep('repair-pre-review-ci-failures', 'completed'),
      wireStep('review-pipeline.review-claude', 'completed'),
      wireStep('review-pipeline.review-codex', 'completed'),
      wireStep('review-pipeline.review-gemini', 'completed'),
      wireStep('review-pipeline.synthesize', 'active'),
      wireStep('apply-fixes', 'pending'),
      wireStep('review-pipeline.quality-scorecard', 'pending'),
      wireStep('review-loop', 'pending'),
      wireStep('pre-approval-ci', 'pending'),
      wireStep('repair-pre-approval-ci-failures', 'pending'),
      wireStep('finalize', 'pending'),
      wireStep('cleanup-worktree', 'pending'),
    ];
    const phase = mapRunPhase(issues);
    assert.equal(phase.phase, 'review');
  });

  test('ga-wisp-x0tank shape between steps (nothing active) still reads review, not finalization', () => {
    const issues = [
      root({ id: 'ga-wisp-x0tank', updated_at: '', status: 'pending' }),
      wireStep('preflight', 'completed'),
      wireStep('rebase-check', 'completed'),
      wireStep('review-pipeline.review-claude', 'completed'),
      wireStep('review-pipeline.review-codex', 'completed'),
      wireStep('review-pipeline.review-gemini', 'completed'),
      wireStep('review-pipeline.synthesize', 'pending'),
      wireStep('apply-fixes', 'pending'),
      wireStep('pre-approval-ci', 'pending'),
      wireStep('finalize', 'pending'),
      wireStep('cleanup-worktree', 'pending'),
    ];
    const phase = mapRunPhase(issues);
    assert.equal(phase.phase, 'review');
    // The generic ladder must not mark Approval/Finalization-preceding stages
    // complete past the truth.
    const stages = stageProgress(phase, null, issues);
    const byKey = new Map(stages.map((s) => [s.key, s.status]));
    assert.equal(byKey.get('review'), 'active');
    assert.equal(byKey.get('approval'), 'pending');
    assert.equal(byKey.get('finalization'), 'pending');
  });

  test("all steps 'completed' (wire) → complete, like all 'closed'", () => {
    const phase = mapRunPhase([
      root({ id: 'w3', updated_at: '', status: 'completed' }),
      wireStep('implement-change', 'completed'),
      wireStep('finalize', 'completed'),
    ]);
    assert.equal(phase.phase, 'complete');
  });

  test('freshly poured run (full DAG materialized, all pending) stays conservative', () => {
    const phase = mapRunPhase([
      root({ id: 'w4', updated_at: '', status: 'pending' }),
      wireStep('preflight', 'pending'),
      wireStep('review-loop', 'pending'),
      wireStep('pre-approval-ci', 'pending'),
      wireStep('finalize', 'pending'),
      wireStep('cleanup-worktree', 'pending'),
    ]);
    assert.notEqual(phase.phase, 'approval');
    assert.notEqual(phase.phase, 'finalization');
    assert.equal(phase.phase, 'active');
  });

  test('formula-specific ladder (mol-adopt-pr-v2) reads wire statuses too', () => {
    const issues = [
      root({ id: 'w5', updated_at: '', status: 'pending' }),
      wireStep('preflight', 'completed'),
      wireStep('rebase-check', 'completed'),
      wireStep('review-pipeline.review-claude', 'completed'),
      wireStep('review-pipeline.synthesize', 'active'),
      wireStep('pre-approval-ci', 'pending'),
      wireStep('human-approval', 'pending'),
      wireStep('finalize', 'pending'),
      wireStep('cleanup-worktree', 'pending'),
    ];
    const stages = stageProgress(mapRunPhase(issues), 'mol-adopt-pr-v2', issues);
    const byKey = new Map(stages.map((s) => [s.key, s.status]));
    assert.equal(byKey.get('preflight'), 'complete');
    assert.equal(byKey.get('rebase'), 'complete');
    assert.equal(byKey.get('review'), 'active');
    assert.equal(byKey.get('ci'), 'pending');
    assert.equal(byKey.get('approval'), 'pending');
    assert.equal(byKey.get('finalize'), 'pending');
    assert.equal(byKey.get('cleanup'), 'pending');
  });

  test('bd-fed summary lane: fallback skips OPEN shells too, not only wire-pending ones', () => {
    const phase = mapRunPhase([
      root({ id: 'w6' }),
      step('w6-s1', 'implement-change', 'closed'),
      step('w6-s2', 'human-approval', 'open'),
      step('w6-s3', 'cleanup-worktree', 'open'),
    ]);
    assert.equal(phase.phase, 'implementation');
  });

  test("a raw 'failed' (wire) step counts as advanced — phase does not regress below it", () => {
    // presentationStatus defends against raw 'failed' (status.ts), so phase
    // derivation must too: the step demonstrably ran, and the normal failure
    // encoding (closed + gc.outcome=fail) already ranks as advanced.
    const phase = mapRunPhase([
      root({ id: 'w7', updated_at: '', status: 'pending' }),
      wireStep('implement-change', 'failed'),
      wireStep('cleanup-worktree', 'pending'),
    ]);
    assert.equal(phase.phase, 'implementation');
  });

  test("a raw 'skipped' step does not block an otherwise finished run from 'complete'", () => {
    // A skipped step is resolved — it will never run. Mirrors the bd encoding
    // closed + gc.outcome=skipped, which already counts toward complete.
    const phase = mapRunPhase([
      root({ id: 'w8', updated_at: '', status: 'completed' }),
      wireStep('implement-change', 'completed'),
      wireStep('repair-pre-review-ci-failures', 'skipped'),
      wireStep('finalize', 'completed'),
    ]);
    assert.equal(phase.phase, 'complete');
  });

  test("a raw 'done' step counts as resolved for advancement and completion, like 'completed'", () => {
    // 'done' is an accepted closed spelling (isClosedStatus). Pin it directly so
    // a future status-helper refactor cannot silently drop the arm without a
    // failing test (the other accepted spellings are each already pinned).
    const advanced = mapRunPhase([
      root({ id: 'w-done-1', updated_at: '', status: 'pending' }),
      wireStep('implement-change', 'done'),
      wireStep('cleanup-worktree', 'pending'),
    ]);
    assert.equal(advanced.phase, 'implementation');

    const complete = mapRunPhase([
      root({ id: 'w-done-2', updated_at: '', status: 'done' }),
      wireStep('implement-change', 'done'),
      wireStep('finalize', 'done'),
    ]);
    assert.equal(complete.phase, 'complete');
  });

  test('formula ladder between steps (wire): completed stages + pending remainder → first open stage active', () => {
    // Nothing in flight, so currentIndex falls to the first stage that has not
    // succeeded (!stageSucceeded) — Review here, whose only materialized steps
    // are still pending — and that stage renders active under the wire
    // completed/pending spellings.
    const issues = [
      root({ id: 'w9', updated_at: '', status: 'pending' }),
      wireStep('preflight', 'completed'),
      wireStep('rebase-check', 'completed'),
      wireStep('review-pipeline.review-claude', 'pending'),
      wireStep('apply-fixes', 'pending'),
      wireStep('pre-approval-ci', 'pending'),
      wireStep('human-approval', 'pending'),
      wireStep('finalize', 'pending'),
      wireStep('cleanup-worktree', 'pending'),
    ];
    const stages = stageProgress(mapRunPhase(issues), 'mol-adopt-pr-v2', issues);
    const byKey = new Map(stages.map((s) => [s.key, s.status]));
    assert.equal(byKey.get('preflight'), 'complete');
    assert.equal(byKey.get('rebase'), 'complete');
    assert.equal(byKey.get('review'), 'active');
    assert.equal(byKey.get('ci'), 'pending');
    assert.equal(byKey.get('approval'), 'pending');
  });

  test('completed reviewers with pending synthesize/apply-fixes keep Review active, not complete (F1)', () => {
    // The mol-adopt-pr-v2 Review stage bundles several required steps. A run
    // BETWEEN review substeps — reviewers completed, but synthesize,
    // quality-scorecard, and apply-fixes still pending — must keep Review the
    // current stage. Before the fix one succeeded step completed the whole stage,
    // so Review rendered complete and Pre-approval CI active while required review
    // work was still pending (the ga-wisp-x0tank between-steps shape).
    const issues = [
      root({ id: 'wf5', updated_at: '', status: 'pending' }),
      wireStep('preflight', 'completed'),
      wireStep('rebase-check', 'completed'),
      wireStep('review-pipeline.review-claude', 'completed'),
      wireStep('review-pipeline.review-codex', 'completed'),
      wireStep('review-pipeline.review-gemini', 'completed'),
      wireStep('review-pipeline.synthesize', 'pending'),
      wireStep('review-pipeline.quality-scorecard', 'pending'),
      wireStep('apply-fixes', 'pending'),
      wireStep('pre-approval-ci', 'pending'),
      wireStep('human-approval', 'pending'),
      wireStep('finalize', 'pending'),
      wireStep('cleanup-worktree', 'pending'),
    ];
    const stages = stageProgress(mapRunPhase(issues), 'mol-adopt-pr-v2', issues);
    const byKey = new Map(stages.map((s) => [s.key, s.status]));
    assert.equal(byKey.get('preflight'), 'complete');
    assert.equal(byKey.get('rebase'), 'complete');
    assert.equal(byKey.get('review'), 'active');
    assert.equal(byKey.get('ci'), 'pending');
    assert.equal(byKey.get('approval'), 'pending');
    assert.equal(byKey.get('finalize'), 'pending');
    assert.equal(byKey.get('cleanup'), 'pending');
  });

  // The formula ladder must split SUCCESSFUL completion from mere resolution.
  // isResolvedStatus folds in failed + skipped, so before the fix a failed or
  // skipped step advanced the ladder as if its stage had passed — the failed
  // stage rendered complete while the next materialized pending shell rendered
  // active (the M2 overstatement class, reached through the failed/skipped door).
  test('failed apply-fixes with pending shells (wire): review blocks, the ladder does not advance past it', () => {
    const issues = [
      root({ id: 'wf1', updated_at: '', status: 'pending' }),
      wireStep('preflight', 'completed'),
      wireStep('rebase-check', 'completed'),
      wireStep('review-pipeline.review-claude', 'completed'),
      wireStep('review-pipeline.synthesize', 'completed'),
      wireStep('review-pipeline.quality-scorecard', 'completed'),
      wireStep('apply-fixes', 'failed'),
      wireStep('pre-approval-ci', 'pending'),
      wireStep('human-approval', 'pending'),
      wireStep('finalize', 'pending'),
      wireStep('cleanup-worktree', 'pending'),
    ];
    const stages = stageProgress(mapRunPhase(issues), 'mol-adopt-pr-v2', issues);
    const byKey = new Map(stages.map((s) => [s.key, s.status]));
    assert.equal(byKey.get('preflight'), 'complete');
    assert.equal(byKey.get('rebase'), 'complete');
    assert.equal(byKey.get('review'), 'blocked');
    assert.equal(byKey.get('ci'), 'pending');
    assert.equal(byKey.get('approval'), 'pending');
    assert.equal(byKey.get('finalize'), 'pending');
    assert.equal(byKey.get('cleanup'), 'pending');
  });

  test('skipped late tail (wire), root unresolved: the skip stays current, later stages do not complete', () => {
    // Every late step is 'skipped' (resolved), so the pre-fix ladder marked the
    // whole tail complete. A skipped step did not run — it must not render its
    // stage, or any later stage, as done.
    const issues = [
      root({ id: 'wf2', updated_at: '', status: 'pending' }),
      wireStep('preflight', 'completed'),
      wireStep('rebase-check', 'completed'),
      wireStep('review-pipeline.review-claude', 'completed'),
      wireStep('review-pipeline.synthesize', 'completed'),
      wireStep('apply-fixes', 'completed'),
      wireStep('pre-approval-ci', 'skipped'),
      wireStep('human-approval', 'skipped'),
      wireStep('finalize', 'skipped'),
      wireStep('cleanup-worktree', 'skipped'),
    ];
    const stages = stageProgress(mapRunPhase(issues), 'mol-adopt-pr-v2', issues);
    const byKey = new Map(stages.map((s) => [s.key, s.status]));
    assert.equal(byKey.get('review'), 'complete');
    assert.equal(byKey.get('ci'), 'active');
    assert.equal(byKey.get('approval'), 'pending');
    assert.equal(byKey.get('finalize'), 'pending');
    assert.equal(byKey.get('cleanup'), 'pending');
  });

  // The contrast to the root-unresolved case above. The bypassed-tail-parks-
  // active rule is right ONLY while the run is still in flight: a skipped tail
  // cannot prove the run passed it. Once the whole run is resolved (mapRunPhase
  // → complete) there is no work left to be 'current', so a skipped or
  // unmaterialized tail must render complete, not a stuck active stage.
  test('skipped tail, root RESOLVED (complete): every stage renders complete, no parked active tail (M-2)', () => {
    // An accepted-as-is adopt-pr run: the CI/approval/finalize/cleanup tail was
    // skipped while the root closed complete.
    const issues = [
      root({ id: 'wfc1', updated_at: '', status: 'completed' }),
      wireStep('preflight', 'completed'),
      wireStep('rebase-check', 'completed'),
      wireStep('review-pipeline.review-claude', 'completed'),
      wireStep('review-pipeline.synthesize', 'completed'),
      wireStep('apply-fixes', 'completed'),
      wireStep('pre-approval-ci', 'skipped'),
      wireStep('human-approval', 'skipped'),
      wireStep('finalize', 'skipped'),
      wireStep('cleanup-worktree', 'skipped'),
    ];
    const phase = mapRunPhase(issues);
    assert.equal(phase.phase, 'complete');
    const stages = stageProgress(phase, 'mol-adopt-pr-v2', issues);
    for (const stage of stages) {
      assert.equal(stage.status, 'complete', `${stage.key} should be complete`);
    }
  });

  test('UNMATERIALIZED tail, root RESOLVED (complete): every stage renders complete (M-2)', () => {
    // Same completion rule when the tail stages never materialized a bead at all
    // (empty stage). A complete run must not show a pending/active tail just
    // because the later steps were never poured.
    const issues = [
      root({ id: 'wfc2', updated_at: '', status: 'completed' }),
      wireStep('preflight', 'completed'),
      wireStep('rebase-check', 'completed'),
      wireStep('review-pipeline.review-claude', 'completed'),
      wireStep('review-pipeline.synthesize', 'completed'),
      wireStep('apply-fixes', 'completed'),
    ];
    const phase = mapRunPhase(issues);
    assert.equal(phase.phase, 'complete');
    const stages = stageProgress(phase, 'mol-adopt-pr-v2', issues);
    for (const stage of stages) {
      assert.equal(stage.status, 'complete', `${stage.key} should be complete`);
    }
  });

  test('RESOLVED run with a failed stage still renders it blocked, not falsely complete (M-2 guard)', () => {
    // Over-correction guard: the complete-run rule must not paper over a real
    // failure. mapRunPhase buckets an all-resolved run as complete even when a
    // step FAILED, so the formula ladder must still surface the failure point as
    // blocked — never swallow it into a green 'complete'. The skipped tail after
    // the failure is honestly pending, not retroactively complete.
    const issues = [
      root({ id: 'wfc3', updated_at: '', status: 'completed' }),
      wireStep('preflight', 'completed'),
      wireStep('rebase-check', 'completed'),
      wireStep('review-pipeline.review-claude', 'completed'),
      wireStep('review-pipeline.synthesize', 'completed'),
      wireStep('apply-fixes', 'failed'),
      wireStep('pre-approval-ci', 'skipped'),
      wireStep('human-approval', 'skipped'),
      wireStep('finalize', 'skipped'),
      wireStep('cleanup-worktree', 'skipped'),
    ];
    const phase = mapRunPhase(issues);
    assert.equal(phase.phase, 'complete');
    const stages = stageProgress(phase, 'mol-adopt-pr-v2', issues);
    const byKey = new Map(stages.map((s) => [s.key, s.status]));
    assert.equal(byKey.get('preflight'), 'complete');
    assert.equal(byKey.get('rebase'), 'complete');
    assert.equal(byKey.get('review'), 'blocked');
  });

  test('conditional skip alongside a real success still completes the stage', () => {
    // repair-ci-failures is skipped whenever CI is green; the CI stage still
    // PASSED via pre-approval-ci. The skip must not demote a genuinely complete
    // stage — guards against over-correcting the failed/skipped fix.
    const issues = [
      root({ id: 'wf3', updated_at: '', status: 'pending' }),
      wireStep('preflight', 'completed'),
      wireStep('rebase-check', 'completed'),
      wireStep('review-pipeline.review-claude', 'completed'),
      wireStep('review-pipeline.synthesize', 'completed'),
      wireStep('apply-fixes', 'completed'),
      wireStep('pre-approval-ci', 'completed'),
      wireStep('repair-ci-failures', 'skipped'),
      wireStep('human-approval', 'pending'),
      wireStep('finalize', 'pending'),
      wireStep('cleanup-worktree', 'pending'),
    ];
    const stages = stageProgress(mapRunPhase(issues), 'mol-adopt-pr-v2', issues);
    const byKey = new Map(stages.map((s) => [s.key, s.status]));
    assert.equal(byKey.get('review'), 'complete');
    assert.equal(byKey.get('ci'), 'complete');
    assert.equal(byKey.get('approval'), 'active');
    assert.equal(byKey.get('finalize'), 'pending');
  });

  test('bd-encoded failure (closed + gc.outcome=fail) blocks the stage, like a wire failure', () => {
    // The summary lane feeds bd ledger statuses: a failed step is closed with
    // gc.outcome=fail, not raw 'failed'. The ladder reads the outcome so the lane
    // and the run-detail page agree on where the run failed.
    const failed = (id: string, stepId: string): RunIssue =>
      step(id, stepId, 'closed', {
        metadata: { 'gc.kind': 'step', 'gc.step_id': stepId, 'gc.outcome': 'fail' },
      });
    const issues = [
      root({ id: 'wf4', status: 'open' }),
      step('wf4-s1', 'preflight', 'closed'),
      step('wf4-s2', 'rebase-check', 'closed'),
      step('wf4-s3', 'review-pipeline.review-claude', 'closed'),
      failed('wf4-s4', 'apply-fixes'),
      step('wf4-s5', 'pre-approval-ci', 'open'),
      step('wf4-s6', 'human-approval', 'open'),
      step('wf4-s7', 'finalize', 'open'),
      step('wf4-s8', 'cleanup-worktree', 'open'),
    ];
    const stages = stageProgress(mapRunPhase(issues), 'mol-adopt-pr-v2', issues);
    const byKey = new Map(stages.map((s) => [s.key, s.status]));
    assert.equal(byKey.get('preflight'), 'complete');
    assert.equal(byKey.get('rebase'), 'complete');
    assert.equal(byKey.get('review'), 'blocked');
    assert.equal(byKey.get('ci'), 'pending');
    assert.equal(byKey.get('approval'), 'pending');
  });

  test('retried step (real graph.v2 shape): a stale failed attempt.1 does not block the stage after attempt.2 passes (F1)', () => {
    // apply-fixes failed at attempt.1 then passed at attempt.2 within review-loop
    // iteration 6. The work beads carry attempt-suffixed gc.step_id/step_ref;
    // gc.attempt is the iteration (6) on BOTH, so cohorting keys off the
    // `.attempt.N` suffix. latestAttempt must keep only attempt.2 (passed) — the
    // stale failed attempt.1 must not pin Review to blocked — so Review completes
    // and the ladder advances to Pre-approval CI. The base-id retry latch
    // (gc.kind=retry) ranks attempt 0 and is superseded too.
    const issues = [
      root({ id: 'wf-retry-real', updated_at: '', status: 'pending' }),
      wireStep('preflight', 'completed'),
      wireStep('rebase-check', 'completed'),
      wireStep('review-pipeline.review-claude', 'completed'),
      wireStep('review-pipeline.synthesize', 'completed'),
      wireStep('review-pipeline.quality-scorecard', 'completed'),
      retryLatch('apply-fixes', 'completed'),
      workAttempt('apply-fixes', 1, 'failed'),
      workAttempt('apply-fixes', 2, 'completed'),
      wireStep('pre-approval-ci', 'pending'),
      wireStep('human-approval', 'pending'),
      wireStep('finalize', 'pending'),
      wireStep('cleanup-worktree', 'pending'),
    ];
    const stages = stageProgress(mapRunPhase(issues), 'mol-adopt-pr-v2', issues);
    const byKey = new Map(stages.map((s) => [s.key, s.status]));
    assert.equal(byKey.get('review'), 'complete');
    assert.equal(byKey.get('ci'), 'active');
    assert.equal(byKey.get('approval'), 'pending');
    assert.equal(byKey.get('finalize'), 'pending');
    assert.equal(byKey.get('cleanup'), 'pending');
  });

  test('retried step (real graph.v2 shape): an in-flight attempt-suffixed work bead is matched to its stage', () => {
    // Mirrors the live shape of this very run: apply-fixes.attempt.1 in flight
    // under review-loop.iteration.6, with the base id only on the gc.kind=retry
    // latch. Exact gc.step_id matching missed the suffixed work bead, so its stage
    // saw only the open latch and mis-derived the current stage; base-id cohorting
    // places the in-flight work bead in Review, keeping Review the active stage.
    const issues = [
      root({ id: 'wf-inflight-real', updated_at: '', status: 'pending' }),
      wireStep('preflight', 'completed'),
      wireStep('rebase-check', 'completed'),
      wireStep('review-pipeline.review-claude', 'completed'),
      wireStep('review-pipeline.review-codex', 'completed'),
      wireStep('review-pipeline.synthesize', 'completed'),
      wireStep('review-pipeline.quality-scorecard', 'completed'),
      retryLatch('apply-fixes', 'open'),
      workAttempt('apply-fixes', 1, 'active'),
      wireStep('pre-approval-ci', 'pending'),
      wireStep('human-approval', 'pending'),
      wireStep('finalize', 'pending'),
      wireStep('cleanup-worktree', 'pending'),
    ];
    const stages = stageProgress(mapRunPhase(issues), 'mol-adopt-pr-v2', issues);
    const byKey = new Map(stages.map((s) => [s.key, s.status]));
    assert.equal(byKey.get('preflight'), 'complete');
    assert.equal(byKey.get('rebase'), 'complete');
    assert.equal(byKey.get('review'), 'active');
    assert.equal(byKey.get('ci'), 'pending');
    assert.equal(byKey.get('approval'), 'pending');
    assert.equal(byKey.get('finalize'), 'pending');
    assert.equal(byKey.get('cleanup'), 'pending');
  });

  test('bypassed (skipped) middle stage before a later success completes, not stalls the ladder (F2)', () => {
    // human-approval was skipped (auto-approve), yet finalize and cleanup then
    // completed. A fully-skipped MIDDLE stage with later succeeded stages must
    // render complete — the run demonstrably moved past it — instead of pinning
    // the ladder at approval and mislabeling the completed tail pending.
    const issues = [
      root({ id: 'wf-bypass', updated_at: '', status: 'completed' }),
      wireStep('preflight', 'completed'),
      wireStep('rebase-check', 'completed'),
      wireStep('review-pipeline.review-claude', 'completed'),
      wireStep('review-pipeline.synthesize', 'completed'),
      wireStep('apply-fixes', 'completed'),
      wireStep('pre-approval-ci', 'completed'),
      wireStep('human-approval', 'skipped'),
      wireStep('finalize', 'completed'),
      wireStep('cleanup-worktree', 'completed'),
    ];
    const stages = stageProgress(mapRunPhase(issues), 'mol-adopt-pr-v2', issues);
    const byKey = new Map(stages.map((s) => [s.key, s.status]));
    assert.equal(byKey.get('review'), 'complete');
    assert.equal(byKey.get('ci'), 'complete');
    assert.equal(byKey.get('approval'), 'complete');
    assert.equal(byKey.get('finalize'), 'complete');
    assert.equal(byKey.get('cleanup'), 'complete');
  });

  test('unmaterialized (empty) middle stage before a later success completes (F2)', () => {
    // The same advance-past-a-bypassed-stage rule for a stage that never
    // materialized at all (no human-approval bead): finalize + cleanup completed,
    // so the empty approval stage must render complete, not stall the ladder.
    const issues = [
      root({ id: 'wf-empty', updated_at: '', status: 'completed' }),
      wireStep('preflight', 'completed'),
      wireStep('rebase-check', 'completed'),
      wireStep('review-pipeline.review-claude', 'completed'),
      wireStep('review-pipeline.synthesize', 'completed'),
      wireStep('apply-fixes', 'completed'),
      wireStep('pre-approval-ci', 'completed'),
      // human-approval never materialized — the approval stage has no beads.
      wireStep('finalize', 'completed'),
      wireStep('cleanup-worktree', 'completed'),
    ];
    const stages = stageProgress(mapRunPhase(issues), 'mol-adopt-pr-v2', issues);
    const byKey = new Map(stages.map((s) => [s.key, s.status]));
    assert.equal(byKey.get('review'), 'complete');
    assert.equal(byKey.get('ci'), 'complete');
    assert.equal(byKey.get('approval'), 'complete');
    assert.equal(byKey.get('finalize'), 'complete');
    assert.equal(byKey.get('cleanup'), 'complete');
  });

  test("two concurrently 'active' (wire) reviewers with empty timestamps resolve deterministically", () => {
    // The review-wave norm: multiple reviewers in flight at once, updated_at=''
    // on every snapshot bead. The pick must come from the rank/id tiebreak, not
    // input order.
    const issues = [
      root({ id: 'w10', updated_at: '', status: 'pending' }),
      wireStep('review-pipeline.review-codex', 'active'),
      wireStep('review-pipeline.review-claude', 'active'),
      wireStep('preflight', 'completed'),
      wireStep('cleanup-worktree', 'pending'),
    ];
    assert.equal(mapRunPhase(issues).phase, 'review');
    assert.equal(mapRunPhase([...issues].reverse()).phase, 'review');
  });
});

describe('mapRunPhase — first-class-only step refs without a gc.step_id mirror (codex Major)', () => {
  // The run-detail snapshot adapter (formula-run.fromRunSnapshotBead) preserves a
  // supervisor row's first-class step_ref/scope_ref even when the row omits the
  // gc.step_id metadata mirror. Step identity must then derive the step id from
  // those refs (scope_ref + "." stripped off step_ref), or both the structured
  // phase pick and the formula-stage ladder silently ignore valid run-detail data
  // — the phase falls through to the conservative 'active' fallback and the ladder
  // parks on preflight. These fixtures carry ONLY the first-class refs: metadata
  // holds the kind but no gc.step_id / gc.step_ref / gc.scope_ref mirror.
  const MOLECULE = 'mol-adopt-pr-v2';
  const ITERATION_SCOPE = `${MOLECULE}.review-loop.iteration.3`;
  function refOnlyStep(stepId: string, status: string, scopeRef: string): RunIssue {
    return {
      id: `fc-${stepId}`,
      title: 'step',
      status,
      issue_type: 'task',
      updated_at: '',
      step_ref: `${scopeRef}.${stepId}`,
      scope_ref: scopeRef,
      metadata: { 'gc.kind': 'work' },
    };
  }

  test('an active review step carried first-class-only drives the review phase, not the active fallback', () => {
    const issues = [
      root({ id: 'fc-run', updated_at: '', status: 'pending' }),
      refOnlyStep('review-pipeline.review-claude', 'active', ITERATION_SCOPE),
    ];
    // Before the fix latestStepId/furthestStageStepId read only gc.step_id, found
    // none, and mapRunPhase fell through to the keyword fallback → 'active'.
    assert.equal(mapRunPhase(issues).phase, 'review');
  });

  test('the formula ladder honors first-class-only refs instead of parking on preflight', () => {
    // A realistic between-steps mol-adopt-pr-v2 run whose entire step identity is
    // first-class refs: top-level steps scope to the molecule root, the in-flight
    // retried apply-fixes work bead scopes to the review-loop iteration and carries
    // an attempt suffix. The derived ids must place Review as the active stage.
    const issues = [
      root({ id: 'fc-run2', updated_at: '', status: 'pending' }),
      refOnlyStep('preflight', 'completed', MOLECULE),
      refOnlyStep('rebase-check', 'completed', MOLECULE),
      refOnlyStep('apply-fixes.attempt.1', 'active', ITERATION_SCOPE),
    ];
    const stages = stageProgress(mapRunPhase(issues), MOLECULE, issues);
    const byKey = new Map(stages.map((s) => [s.key, s.status]));
    // Before the fix none of these refs resolved to a step id, so every stage was
    // "bypassed", currentIndex fell to 0, and Preflight rendered active.
    assert.equal(byKey.get('preflight'), 'complete');
    assert.equal(byKey.get('rebase'), 'complete');
    assert.equal(byKey.get('review'), 'active');
    assert.equal(byKey.get('ci'), 'pending');
    assert.equal(byKey.get('approval'), 'pending');
    assert.equal(byKey.get('finalize'), 'pending');
    assert.equal(byKey.get('cleanup'), 'pending');
  });

  test('a gc.step_id mirror still wins when present (first-class refs do not override it)', () => {
    // The summary/dashboard projection always carries the mirror; the accessor must
    // prefer it so mirrored summary-lane beads and first-class-only run-detail beads
    // for the same step resolve identically.
    const issues = [
      root({ id: 'fc-run3', updated_at: '', status: 'pending' }),
      {
        id: 'mirrored',
        title: 'step',
        status: 'active',
        issue_type: 'task',
        updated_at: '',
        // The ref points at finalize, but the mirror says apply-fixes — the mirror wins.
        step_ref: `${ITERATION_SCOPE}.finalize`,
        scope_ref: ITERATION_SCOPE,
        metadata: { 'gc.kind': 'work', 'gc.step_id': 'apply-fixes' },
      } satisfies RunIssue,
    ];
    const stages = stageProgress(mapRunPhase(issues), MOLECULE, issues);
    const byKey = new Map(stages.map((s) => [s.key, s.status]));
    assert.equal(byKey.get('review'), 'active');
    assert.equal(byKey.get('finalize'), 'pending');
  });
});

describe('stepIdPhase — step-identity classification', () => {
  test('classifies representative declared step ids', () => {
    assert.equal(stepIdPhase('bootstrap-run'), 'intake');
    assert.equal(stepIdPhase('preflight'), 'intake');
    assert.equal(stepIdPhase('implement-change'), 'implementation');
    assert.equal(stepIdPhase('implementation.patch'), 'implementation');
    assert.equal(stepIdPhase('do-work'), 'implementation');
    assert.equal(stepIdPhase('review-pipeline.review-claude'), 'review');
    assert.equal(stepIdPhase('code-review-loop'), 'review');
    assert.equal(stepIdPhase('human-approval'), 'approval');
    assert.equal(stepIdPhase('approve-merge'), 'approval');
    assert.equal(stepIdPhase('merge-and-finalize'), 'finalization');
    assert.equal(stepIdPhase('cleanup-worktree'), 'finalization');
  });

  test('unknown step id is conservative (active), never invents a late phase', () => {
    assert.equal(stepIdPhase('totally-unknown-step'), 'active');
  });

  // gascity-dashboard (Major 1): tokenized whole-token matching, not raw
  // substring includes(). A leading/CI step that merely CONTAINS a late-stage
  // word as a substring (or as a token behind a negating prefix) must not be
  // misbucketed onto the late stage — that falsely surfaces a CI step as
  // "waiting on human" through needsOperator (health.ts keys on phase==='approval').
  test('pre-approval-ci is NOT approval (negating `pre` prefix on the gate token)', () => {
    assert.notEqual(stepIdPhase('pre-approval-ci'), 'approval');
  });

  test('dispatch-implementation is implementation, not finalization', () => {
    assert.equal(stepIdPhase('dispatch-implementation'), 'implementation');
  });

  test('prepare-review-context is review, never approval or finalization', () => {
    const phase = stepIdPhase('prepare-review-context');
    assert.notEqual(phase, 'approval');
    assert.notEqual(phase, 'finalization');
    assert.equal(phase, 'review');
  });

  test('whole real step ids still classify correctly after tokenization', () => {
    assert.equal(stepIdPhase('review'), 'review');
    assert.equal(stepIdPhase('approval'), 'approval');
    assert.equal(stepIdPhase('approve'), 'approval');
    assert.equal(stepIdPhase('implementation'), 'implementation');
    assert.equal(stepIdPhase('do-work'), 'implementation');
    assert.equal(stepIdPhase('load-context'), 'intake');
    assert.equal(stepIdPhase('finalize'), 'finalization');
  });

  test('a substring that is not a whole token does not match (e.g. `approval` inside a longer token)', () => {
    // `disapproval-note` tokenizes to [disapproval, note]; neither token is a
    // recognized stage word, so the old includes('approval') false positive
    // is gone.
    assert.equal(stepIdPhase('disapproval-note'), 'active');
  });

  // gascity-dashboard (Residual A): the gate stages (approval, finalization)
  // reject the stage token when ANY lead-up qualifier token appears anywhere in
  // the step-id tokens — not only when the qualifier immediately precedes the
  // stage token. `wait-for-approval` ([wait,for,approval]) and `prepare-for-merge`
  // ([prepare,for,merge]) are steps that LEAD UP TO the gate, so they must not
  // classify as the gate even though the token before the stage token is `for`.
  describe('gate stages reject any lead-up qualifier token anywhere (Residual A)', () => {
    test('pre-approval-ci is NOT approval (qualifier `pre` anywhere)', () => {
      assert.notEqual(stepIdPhase('pre-approval-ci'), 'approval');
    });

    test('wait-for-approval is NOT approval (qualifier `wait`/`for`, not adjacent)', () => {
      assert.notEqual(stepIdPhase('wait-for-approval'), 'approval');
    });

    test('prepare-for-merge is NOT finalization (qualifier `prepare`/`for`, not adjacent)', () => {
      assert.notEqual(stepIdPhase('prepare-for-merge'), 'finalization');
    });

    test('true gates still classify: approval/approve → approval', () => {
      assert.equal(stepIdPhase('approval'), 'approval');
      assert.equal(stepIdPhase('approve'), 'approval');
    });

    test('true gates still classify: finalize/finalization → finalization', () => {
      assert.equal(stepIdPhase('finalize'), 'finalization');
      assert.equal(stepIdPhase('finalization'), 'finalization');
    });

    test('approve-merge is approval — it IS the approval step, no lead-up qualifier', () => {
      assert.equal(stepIdPhase('approve-merge'), 'approval');
    });

    test('non-gate stages keep classifying on a whole stage token (no qualifier rejection)', () => {
      assert.equal(stepIdPhase('review'), 'review');
      assert.equal(stepIdPhase('do-work'), 'implementation');
      assert.equal(stepIdPhase('implementation'), 'implementation');
      assert.equal(stepIdPhase('load-context'), 'intake');
    });
  });
});

// gascity-dashboard (Residual B): furthestStageStepId / latestStepId stage
// tiebreak rank the lifecycle order intake → implementation → review → approval
// → finalization, so finalization is the FURTHEST stage. A no-in_progress run
// whose furthest closed step is finalization must read as finalization, not
// approval. The mapRunPhase CURRENT-phase precedence (approval before
// finalization) is a separate concern and stays as-is.
describe('mapRunPhase — finalization is the furthest lifecycle stage (Residual B)', () => {
  function snapshotStep(stepId: string, status: string): RunIssue {
    return {
      id: `step-${stepId}`,
      title: 'step',
      status,
      issue_type: 'task',
      updated_at: '',
      metadata: { 'gc.kind': 'step', 'gc.step_id': stepId },
    };
  }

  test('no in_progress, closed approve-merge + closed merge-and-finalize → finalization (NOT approval)', () => {
    const forward = mapRunPhase([
      root({ id: 'fb1', updated_at: '' }),
      snapshotStep('approve-merge', 'closed'),
      snapshotStep('merge-and-finalize', 'closed'),
    ]);
    const reversed = mapRunPhase([
      root({ id: 'fb1', updated_at: '' }),
      snapshotStep('merge-and-finalize', 'closed'),
      snapshotStep('approve-merge', 'closed'),
    ]);
    assert.equal(forward.phase, 'finalization');
    assert.equal(reversed.phase, forward.phase);
  });

  test('no in_progress, closed review + closed approval → approval (approval furthest of the two)', () => {
    const phase = mapRunPhase([
      root({ id: 'fb2', updated_at: '' }),
      snapshotStep('code-review-loop', 'closed'),
      snapshotStep('human-approval', 'closed'),
    ]);
    assert.equal(phase.phase, 'approval');
  });
});
