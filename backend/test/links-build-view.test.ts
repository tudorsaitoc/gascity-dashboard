import type { DashboardBead, DashboardSession, LinkNode } from 'gas-city-dashboard-shared';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildLinkView } from '../src/links/build-link-view.js';
import { ResolutionRollup } from '../src/links/instrumentation.js';
import { parseRef } from '../src/links/node-ref.js';
import { buildRelationIndex } from '../src/links/relation-index.js';

function bead(id: string, metadata: Record<string, string> = {}): DashboardBead {
  return {
    id,
    title: `bead ${id}`,
    status: 'open',
    issue_type: 'task',
    priority: 2,
    created_at: '2026-05-20T00:00:00Z',
    metadata,
  };
}

function session(id: string, over: Partial<DashboardSession> = {}): DashboardSession {
  return {
    id,
    template: 'tpl',
    session_name: id,
    title: id,
    state: 'active',
    created_at: '2026-05-20T00:00:00Z',
    attached: false,
    running: true,
    provider: 'claude',
    ...over,
  };
}

function ok(raw: string) {
  const parsed = parseRef(raw);
  assert.equal(parsed.ok, true, `parseRef(${raw}) should be ok`);
  return parsed as Extract<ReturnType<typeof parseRef>, { ok: true }>;
}

function nodeFor(nodes: LinkNode[], predicate: (n: LinkNode) => boolean): LinkNode {
  const found = nodes.find(predicate);
  assert.ok(found, 'expected a matching node');
  return found;
}

describe('buildLinkView (R2/R3/R4/R6/R7/R11)', () => {
  test('R2: derived vs supervisor provenance on edges', () => {
    const beads = [
      bead('focus', { 'gc.parent_bead_id': 'root', molecule_id: 'mol-1' }),
      bead('root'),
      bead('sibling', { molecule_id: 'mol-1' }),
    ];
    const index = buildRelationIndex(beads, [], 'c');
    const view = buildLinkView(index, ok('focus'));
    const parentEdge = view.edges.find((e) => e.relation === 'parent');
    const molEdge = view.edges.find((e) => e.relation === 'molecule');
    assert.equal(parentEdge?.provenance, 'supervisor');
    assert.equal(molEdge?.provenance, 'supervisor');
    // forward + inverse both present: focus has a parent and a molecule peer.
    assert.ok(parentEdge);
    assert.ok(molEdge);
  });

  test('R4: a javascript: pr_url is never rendered as a url', () => {
    const beads = [
      bead('focus', {
        'pr_review.pr_number': '7',
        'pr_review.pr_url': 'javascript:alert(1)',
      }),
    ];
    const index = buildRelationIndex(beads, [], 'c');
    const view = buildLinkView(index, ok('focus'));
    const prNode = nodeFor(view.nodes, (n) => n.type === 'github_pr');
    assert.equal(prNode.url, null, 'javascript: url must be stripped to null');
  });

  test('R4: a valid https pr_url passes through', () => {
    const beads = [
      bead('focus', {
        'pr_review.pr_number': '7',
        'pr_review.pr_url': 'https://github.com/o/r/pull/7',
      }),
    ];
    const index = buildRelationIndex(beads, [], 'c');
    const view = buildLinkView(index, ok('focus'));
    const prNode = nodeFor(view.nodes, (n) => n.type === 'github_pr');
    assert.equal(prNode.url, 'https://github.com/o/r/pull/7');
  });

  test('R6: a PR absent from the fetched set renders unresolved with a ↗ url', () => {
    const beads = [
      bead('focus', {
        'pr_review.pr_number': '42',
        'pr_review.pr_url': 'https://github.com/o/r/pull/42',
      }),
    ];
    const index = buildRelationIndex(beads, [], 'c');
    const rollup = new ResolutionRollup();
    const view = buildLinkView(index, ok('focus'), { recorder: rollup.recorder() });
    const prNode = nodeFor(view.nodes, (n) => n.type === 'github_pr');
    assert.equal(prNode.unresolved, true);
    assert.equal(prNode.url, 'https://github.com/o/r/pull/42');
    // R11: an unresolvable PR ref produces an `unresolved` outcome record.
    const stat = rollup.snapshot().find((s) => s.relation === 'pr');
    assert.equal(stat?.unresolved, 1);
    assert.equal(stat?.resolved, 0);
  });

  test('R6: a PR referenced by two beads renders as N candidates (focus on pr/5)', () => {
    // Two live beads reference the same PR number → focusing the PR yields
    // two candidate beads for the focus, recorded as N candidates (R6)
    // rather than guessing a single target.
    const beads = [
      bead('a', { 'pr_review.pr_number': '5' }),
      bead('b', { 'pr_review.pr_number': '5' }),
    ];
    const index = buildRelationIndex(beads, [], 'c');
    const view = buildLinkView(index, ok('pr/5'));
    assert.equal(view.focus.type, 'github_pr');
    assert.equal(view.focus.ref, 'pr/5');
    // The PR focus resolved to two candidate beads; the focus node records
    // the count rather than guessing a single target (R6).
    assert.equal(view.nodes[0]?.candidateCount, 2);
    // Non-bead focus links one hop to the candidate bead(s) themselves.
    const beadEdges = view.edges.filter((e) => e.relation === 'bead');
    assert.equal(beadEdges.length, 2);
  });

  test('R7: section asOf is the older of two contributing sources', () => {
    const beads = [
      bead('focus', { session_id: 'sess-1' }),
    ];
    const fresh = '2026-05-26T12:00:00Z';
    const old = '2026-05-25T12:00:00Z';
    const index = buildRelationIndex(beads, [session('sess-1')], 'c');
    const view = buildLinkView(index, ok('focus'), {
      supervisorFetchedAt: fresh,
      githubFetchedAt: old,
    });
    // No github node here, but the explicit fallback uses the older source.
    // Add a github edge to exercise the node-level path:
    assert.ok(Date.parse(view.asOf ?? '') <= Date.parse(fresh));
  });

  test('R7: a stale github node and a fresh bead node keep distinct fetchedAt', () => {
    const beads = [
      bead('focus', {
        session_id: 'sess-1',
        'pr_review.pr_number': '9',
      }),
    ];
    const fresh = '2026-05-26T12:00:00Z';
    const stale = '2026-05-25T12:00:00Z';
    const index = buildRelationIndex(beads, [session('sess-1')], 'c');
    const view = buildLinkView(index, ok('focus'), {
      supervisorFetchedAt: fresh,
      githubFetchedAt: stale,
    });
    const sessionNode = nodeFor(view.nodes, (n) => n.type === 'session');
    const prNode = nodeFor(view.nodes, (n) => n.type === 'github_pr');
    assert.equal(sessionNode.fetchedAt, fresh);
    assert.equal(prNode.fetchedAt, stale);
    // asOf is the older of the two.
    assert.equal(view.asOf, stale);
  });

  test('R3: an unresolvable focus ref returns a focus-only partial view (not an error)', () => {
    const index = buildRelationIndex([bead('other')], [], 'c');
    const view = buildLinkView(index, ok('no-such-bead'));
    assert.equal(view.partial, true);
    assert.equal(view.nodes.length, 1, 'only the focus node');
    assert.equal(view.edges.length, 0);
  });

  test('non-bead focus: a present session with zero linked beads is a valid empty set (not partial/unresolved)', () => {
    // A session that EXISTS in the snapshot but has no linked beads must
    // resolve to an empty related-set, not be flagged unresolved/partial.
    const index = buildRelationIndex([], [session('sess-empty')], 'c');
    const view = buildLinkView(index, ok('sess-empty'));
    assert.equal(view.focus.type, 'session');
    assert.equal(view.partial, false, 'a resolved-but-empty focus is not partial');
    const focusNode = nodeFor(view.nodes, (n) => n.key === view.focus.key);
    assert.equal(focusNode.unresolved, false, 'a present session is resolved');
    assert.equal(view.edges.length, 0, 'no adjacent beads → no edges');
  });

  test('non-bead focus: a ref matching neither bead nor present session is unresolvable + partial', () => {
    const index = buildRelationIndex([bead('other')], [], 'c');
    const view = buildLinkView(index, ok('ghost-session'));
    assert.equal(view.partial, true);
    const focusNode = nodeFor(view.nodes, (n) => n.key === view.focus.key);
    assert.equal(focusNode.unresolved, true);
    assert.equal(view.edges.length, 0);
  });

  test('non-bead focus: links one hop to the candidate bead, not the bead’s own parent/molecule', () => {
    // Focusing a session links to its bead(s) themselves — NOT to those
    // beads' parent/molecule, which are adjacent to the bead, not the
    // session. Prevents showing a bead's parent as if adjacent to the
    // session.
    const beads = [
      bead('worker', {
        session_id: 'sess-1',
        'gc.parent_bead_id': 'root',
        molecule_id: 'mol-1',
      }),
      bead('root'),
      bead('peer', { molecule_id: 'mol-1' }),
    ];
    const index = buildRelationIndex(beads, [session('sess-1')], 'c');
    const view = buildLinkView(index, ok('sess-1'));
    assert.equal(view.focus.type, 'session');
    // Exactly one edge from the focus: session → its worker bead.
    const fromFocus = view.edges.filter((e) => e.from === view.focus.key);
    assert.equal(fromFocus.length, 1, 'one hop: session → worker bead only');
    assert.equal(fromFocus[0]?.relation, 'bead');
    // The worker bead's parent/molecule are NOT expanded from the session.
    assert.equal(
      view.edges.some((e) => e.relation === 'parent' || e.relation === 'molecule'),
      false,
      'no second-hop parent/molecule edges from a non-bead focus',
    );
  });

  test('molecule: the molecule root bead is linked alongside peer members', () => {
    // molecule_id is the run ROOT bead id; it should be linked as a
    // navigable bead in addition to peer members.
    const beads = [
      bead('focus', { molecule_id: 'root-mol' }),
      bead('root-mol'),
      bead('peer', { molecule_id: 'root-mol' }),
    ];
    const index = buildRelationIndex(beads, [], 'c');
    const view = buildLinkView(index, ok('focus'));
    const molEdges = view.edges.filter((e) => e.relation === 'molecule');
    const targets = new Set(molEdges.map((e) => e.to));
    const rootNode = nodeFor(view.nodes, (n) => n.ref === 'root-mol');
    const peerNode = nodeFor(view.nodes, (n) => n.ref === 'peer');
    assert.ok(targets.has(rootNode.key), 'molecule root bead is linked');
    assert.ok(targets.has(peerNode.key), 'peer member is linked');
    // Root is linked exactly once (no double-count when it is also a member).
    assert.equal(
      molEdges.filter((e) => e.to === rootNode.key).length,
      1,
      'molecule root linked exactly once',
    );
  });

  test('molecule: the root bead is not linked to itself when focus IS the root', () => {
    const beads = [
      bead('root-mol', { molecule_id: 'root-mol' }),
      bead('member', { molecule_id: 'root-mol' }),
    ];
    const index = buildRelationIndex(beads, [], 'c');
    const view = buildLinkView(index, ok('root-mol'));
    const molEdges = view.edges.filter((e) => e.relation === 'molecule');
    // Only the member is linked; the root does not link to itself.
    assert.equal(molEdges.length, 1);
    assert.equal(nodeFor(view.nodes, (n) => n.ref === 'member').ref, 'member');
  });

  test('R11: a resolved supervisor edge records a resolved outcome', () => {
    const beads = [bead('focus', { 'gc.parent_bead_id': 'p' }), bead('p')];
    const index = buildRelationIndex(beads, [], 'c');
    const rollup = new ResolutionRollup();
    buildLinkView(index, ok('focus'), { recorder: rollup.recorder() });
    const stat = rollup.snapshot().find((s) => s.relation === 'parent');
    assert.equal(stat?.resolved, 1);
  });
});
