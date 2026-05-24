import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type {
  ContributorStat,
  MaintainerTriage,
  TriageAssessment,
  TriageItem,
  TriageKind,
  TriageTier,
} from 'gas-city-dashboard-shared';
import { runRefresh } from '../src/maintainer/worker.js';
import { readCache } from '../src/maintainer/storage.js';
import {
  readSlungState,
  slungKey,
  writeSlungEntry,
} from '../src/maintainer/slung-state.js';

// Worker slung-state purge (gascity-dashboard-4jy).
//
// The 9qs serve-time overlay forces item.slung=null for vetted items so
// the rendered envelope is always correct, but the on-disk slung-state.json
// keeps accumulating entries because nothing trims them. This wave teaches
// the worker to call purgeSlungKeys after each successful runRefresh,
// passing the keys of every item that has triage_assessment != null.
//
// Tests use an injected fetchTriage so runRefresh can be driven without
// shelling out to gh, and a tmpdir per case so concurrent test runs don't
// collide on the slung-state file.

let tmpDir: string;
let cachePath: string;
let slungStatePath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-test-'));
  cachePath = path.join(tmpDir, 'maintainer-cache.json');
  slungStatePath = path.join(tmpDir, 'slung-state.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeItem(
  kind: TriageKind,
  number: number,
  overrides: Partial<TriageItem> = {},
): TriageItem {
  const author: ContributorStat = {
    login: 'tester',
    tier: 'regular',
    issues_accepted: null,
    issues_opened: null,
    prs_merged: null,
    prs_opened: null,
    computed_at: null,
  };
  return {
    kind,
    number,
    title: `item ${kind} ${number}`,
    status: 'open',
    author,
    created_at: '2026-05-24T12:00:00.000Z',
    updated_at: '2026-05-24T12:00:00.000Z',
    labels: [],
    tier: 'stability',
    triage_score: 0,
    triage_assessment: null,
    slung: null,
    cluster_id: null,
    blast_files: [],
    lines_changed: null,
    weak_ties: [],
    linked_numbers: [],
    html_url: `https://github.com/test/test/${kind === 'pr' ? 'pull' : 'issues'}/${number}`,
    is_marked: false,
    ...overrides,
  };
}

function makeEnvelope(items: TriageItem[], repo = 'test/test'): MaintainerTriage {
  const tiers = (['regression_breaking', 'regression', 'stability'] as const).map(
    (tier: TriageTier) => ({
      tier,
      clusters: [],
      unclustered: items.filter((i) => i.tier === tier),
    }),
  );
  return {
    computed_at: '2026-05-24T12:00:00.000Z',
    repo,
    tiers,
    totals: {
      issues_open: items.filter((i) => i.kind === 'issue').length,
      prs_open: items.filter((i) => i.kind === 'pr').length,
    },
  };
}

const vettedAssessment: TriageAssessment = {
  vetted_score: 50,
  source: 'agent',
  notes: 'triage agent done',
  vetted_at: '2026-05-24T12:30:00.000Z',
};

describe('runRefresh — slung-state purge for vetted items', () => {
  test('purges slung-state entries for items the envelope marks vetted', async () => {
    // Seed: two slung entries — one for a soon-to-be-vetted item, one
    // for an item still in flight.
    await writeSlungEntry(slungStatePath, slungKey('pr', 1), {
      slung_at: '2026-05-24T12:00:00.000Z',
      target: 'chief-of-staff',
      bead_id: 'gastown-vetted',
    });
    await writeSlungEntry(slungStatePath, slungKey('issue', 2), {
      slung_at: '2026-05-24T12:00:00.000Z',
      target: 'chief-of-staff',
      bead_id: 'gastown-pending',
    });

    const vetted = makeItem('pr', 1, { triage_assessment: vettedAssessment });
    const pending = makeItem('issue', 2, { triage_assessment: null });
    const fetchTriage = async (): Promise<MaintainerTriage> =>
      makeEnvelope([vetted, pending]);

    await runRefresh({
      repo: 'test/test',
      cachePath,
      slungStatePath,
      intervalMs: 60_000,
      fetchTriage,
    });

    const state = await readSlungState(slungStatePath);
    assert.equal(state['pr:1'], undefined, 'vetted PR entry should be purged');
    assert.ok(state['issue:2'], 'pending issue entry should remain');
    assert.equal(Object.keys(state).length, 1);

    // Cache was still written — the purge is a side-effect, not a gate.
    const cached = await readCache(cachePath);
    assert.ok(cached);
    assert.equal(cached?.repo, 'test/test');
  });

  test('walks clustered + unclustered items across all tiers', async () => {
    // Seed entries for items that will appear in different tiers AND
    // inside a cluster so the collectItems walk is exercised end-to-end.
    await writeSlungEntry(slungStatePath, slungKey('pr', 10), {
      slung_at: '2026-05-24T12:00:00.000Z',
      target: 'chief-of-staff',
      bead_id: 'a',
    });
    await writeSlungEntry(slungStatePath, slungKey('issue', 20), {
      slung_at: '2026-05-24T12:00:00.000Z',
      target: 'chief-of-staff',
      bead_id: 'b',
    });

    const clusteredVetted = makeItem('pr', 10, {
      tier: 'regression_breaking',
      triage_assessment: vettedAssessment,
    });
    const unclusteredVetted = makeItem('issue', 20, {
      tier: 'regression',
      triage_assessment: vettedAssessment,
    });

    const envelope: MaintainerTriage = {
      computed_at: '2026-05-24T12:00:00.000Z',
      repo: 'test/test',
      tiers: [
        {
          tier: 'regression_breaking',
          clusters: [
            {
              cluster_id: 'c1',
              files: ['foo.ts'],
              items: [clusteredVetted],
              lines_pending: 0,
            },
          ],
          unclustered: [],
        },
        { tier: 'regression', clusters: [], unclustered: [unclusteredVetted] },
        { tier: 'stability', clusters: [], unclustered: [] },
      ],
      totals: { issues_open: 1, prs_open: 1 },
    };

    const fetchTriage = async (): Promise<MaintainerTriage> => envelope;

    await runRefresh({
      repo: 'test/test',
      cachePath,
      slungStatePath,
      intervalMs: 60_000,
      fetchTriage,
    });

    const state = await readSlungState(slungStatePath);
    assert.equal(state['pr:10'], undefined, 'clustered vetted item purged');
    assert.equal(state['issue:20'], undefined, 'unclustered vetted item purged');
    assert.equal(Object.keys(state).length, 0);
  });

  test('is a no-op on slung-state when no items are vetted', async () => {
    await writeSlungEntry(slungStatePath, slungKey('pr', 1), {
      slung_at: '2026-05-24T12:00:00.000Z',
      target: 'chief-of-staff',
      bead_id: 'a',
    });

    const stillPending = makeItem('pr', 1, { triage_assessment: null });
    const fetchTriage = async (): Promise<MaintainerTriage> =>
      makeEnvelope([stillPending]);

    await runRefresh({
      repo: 'test/test',
      cachePath,
      slungStatePath,
      intervalMs: 60_000,
      fetchTriage,
    });

    const state = await readSlungState(slungStatePath);
    assert.ok(state['pr:1'], 'unvetted entry should remain');
    assert.equal(Object.keys(state).length, 1);
  });

  test('refresh failure (fetchTriage throws) leaves slung-state untouched', async () => {
    await writeSlungEntry(slungStatePath, slungKey('pr', 1), {
      slung_at: '2026-05-24T12:00:00.000Z',
      target: 'chief-of-staff',
      bead_id: 'a',
    });

    const fetchTriage = async (): Promise<MaintainerTriage> => {
      throw new Error('upstream gh failed');
    };

    await runRefresh({
      repo: 'test/test',
      cachePath,
      slungStatePath,
      intervalMs: 60_000,
      fetchTriage,
    });

    // No cache, no purge — failed refresh leaves disk untouched.
    const state = await readSlungState(slungStatePath);
    assert.ok(state['pr:1'], 'failed refresh must not purge slung-state');
    const cached = await readCache(cachePath);
    assert.equal(cached, null);
  });
});
