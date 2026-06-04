import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { MaintainerTriage, TriageItem } from 'gas-city-dashboard-shared';
import { makePr } from './fixtures/triage-item.js';
import { slungKey, writeSlungEntry } from './slung-state.js';
import { applySlungOverlay } from './serve-overlay.js';

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function envelopeWithUnclustered(items: TriageItem[]): MaintainerTriage {
  return {
    computed_at: '2026-05-24T00:00:00Z',
    repo: 'gastownhall/gascity',
    tiers: [
      { tier: 'regression_breaking', clusters: [], unclustered: items },
      { tier: 'regression', clusters: [], unclustered: [] },
      { tier: 'stability', clusters: [], unclustered: [] },
    ],
    totals: { issues_open: 0, prs_open: items.length },
  };
}

async function statePath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'serve-overlay-test-'));
  tmpDirs.push(dir);
  return path.join(dir, 'slung-state.json');
}

describe('applySlungOverlay', () => {
  test('lifts active slung items into slung_section and recomputes the One Mark', async () => {
    const top = makePr({ number: 47, triage_score: 320, lines_changed: 50 });
    const next = makePr({ number: 48, triage_score: 290, lines_changed: 200 });
    const envelope = envelopeWithUnclustered([top, next]);
    const pathToState = await statePath();
    await writeSlungEntry(pathToState, slungKey('pr', 47), {
      slung_at: '2026-05-24T10:00:00Z',
      target: 'chief-of-staff',
      bead_id: 'gc-47',
      resolved_session_name: 'oversight-rig__chief-of-staff',
    });

    await applySlungOverlay(envelope, pathToState);

    assert.deepEqual(
      envelope.tiers[0]!.unclustered.map((item) => item.number),
      [48],
    );
    assert.deepEqual(
      envelope.slung_section?.map((item) => item.number),
      [47],
    );
    assert.equal(envelope.slung_section?.[0]?.slung?.target, 'chief-of-staff');
    assert.equal(envelope.slung_section?.[0]?.run_id, 'gc-47');
    assert.equal(envelope.slung_section?.[0]?.is_marked, false);
    assert.equal(envelope.tiers[0]!.unclustered[0]!.is_marked, true);
  });

  test('keeps vetted stale-slung items in their tier with slung and run_id cleared', async () => {
    const vetted = makePr({
      number: 50,
      triage_score: 280,
      triage_assessment: {
        vetted_score: 290,
        source: 'agent',
        notes: '',
        vetted_at: '2026-05-24T00:00:00Z',
      },
    });
    const envelope = envelopeWithUnclustered([vetted]);
    const pathToState = await statePath();
    await writeSlungEntry(pathToState, slungKey('pr', 50), {
      slung_at: '2026-05-23T00:00:00Z',
      target: 'chief-of-staff',
      bead_id: 'gc-stale',
      resolved_session_name: null,
    });

    await applySlungOverlay(envelope, pathToState);

    const item = envelope.tiers[0]!.unclustered[0]!;
    assert.equal(item.number, 50);
    assert.equal(item.slung, null);
    assert.equal(item.run_id, undefined);
    assert.equal(item.is_marked, true);
    assert.deepEqual(envelope.slung_section, []);
  });

  test('drops clusters emptied by lifted slung items', async () => {
    const clustered = makePr({ number: 80, cluster_id: 'c1' });
    const envelope: MaintainerTriage = {
      computed_at: '2026-05-24T00:00:00Z',
      repo: 'gastownhall/gascity',
      tiers: [
        {
          tier: 'regression_breaking',
          clusters: [{ cluster_id: 'c1', files: ['a.go'], items: [clustered], lines_pending: 50 }],
          unclustered: [],
        },
        { tier: 'regression', clusters: [], unclustered: [] },
        { tier: 'stability', clusters: [], unclustered: [] },
      ],
      totals: { issues_open: 0, prs_open: 1 },
    };
    const pathToState = await statePath();
    await writeSlungEntry(pathToState, slungKey('pr', 80), {
      slung_at: '2026-05-24T00:00:00Z',
      target: 'chief-of-staff',
      bead_id: 'gc-80',
      resolved_session_name: null,
    });

    await applySlungOverlay(envelope, pathToState);

    assert.deepEqual(envelope.tiers[0]!.clusters, []);
    assert.deepEqual(
      envelope.slung_section?.map((item) => item.number),
      [80],
    );
  });
});
