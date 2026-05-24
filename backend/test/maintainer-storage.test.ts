import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCache, writeCache } from '../src/maintainer/storage.js';
import type {
  MaintainerTriage,
  TriageItem,
} from 'gas-city-dashboard-shared';

// readCache → null contract: any envelope that doesn't pass the shape check
// (top-level OR a deep spot-check on the first TriageItem) is treated as
// stale, so the next worker tick repopulates fresh. The deep-check exists
// to catch caches written before a new TriageItem field shipped — see
// gascity-dashboard-3qy.

const FIXED_ISO = '2026-05-23T00:00:00.000Z';

function makeItem(overrides: Partial<TriageItem> = {}): TriageItem {
  return {
    kind: 'issue',
    number: 42,
    title: 'sample',
    status: 'open',
    author: {
      login: 'someone',
      tier: 'new',
      issues_accepted: null,
      issues_opened: null,
      prs_merged: null,
      prs_opened: null,
      computed_at: null,
    },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    labels: [],
    tier: 'stability',
    triage_score: 100,
    triage_assessment: null,
    slung: null,
    cluster_id: null,
    blast_files: [],
    lines_changed: null,
    weak_ties: [],
    linked_numbers: [],
    html_url: 'https://example/42',
    is_marked: false,
    ...overrides,
  };
}

function makeEnvelope(items: TriageItem[]): MaintainerTriage {
  return {
    computed_at: FIXED_ISO,
    repo: 'gastownhall/gascity',
    tiers: [
      {
        tier: 'stability',
        clusters: [],
        unclustered: items,
      },
    ],
    totals: { issues_open: items.length, prs_open: 0 },
  };
}

function makeEmptyEnvelope(): MaintainerTriage {
  return {
    computed_at: FIXED_ISO,
    repo: 'gastownhall/gascity',
    tiers: [],
    totals: { issues_open: 0, prs_open: 0 },
  };
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maintainer-storage-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe('readCache — happy path', () => {
  test('round-trips a valid envelope with items', async () => {
    await withTmpDir(async (dir) => {
      const cachePath = path.join(dir, 'cache.json');
      const env = makeEnvelope([makeItem()]);
      await writeCache(cachePath, env);
      const got = await readCache(cachePath);
      assert.deepEqual(got, env);
    });
  });

  test('accepts an envelope with no items (empty tiers — wire shape only)', async () => {
    await withTmpDir(async (dir) => {
      const cachePath = path.join(dir, 'cache.json');
      const env = makeEmptyEnvelope();
      await writeCache(cachePath, env);
      const got = await readCache(cachePath);
      assert.deepEqual(got, env);
    });
  });

  test('accepts an envelope where tiers exist but contain no items', async () => {
    await withTmpDir(async (dir) => {
      const cachePath = path.join(dir, 'cache.json');
      const env: MaintainerTriage = {
        computed_at: FIXED_ISO,
        repo: 'gastownhall/gascity',
        tiers: [
          { tier: 'regression_breaking', clusters: [], unclustered: [] },
          { tier: 'regression', clusters: [], unclustered: [] },
          { tier: 'stability', clusters: [], unclustered: [] },
        ],
        totals: { issues_open: 0, prs_open: 0 },
      };
      await writeCache(cachePath, env);
      const got = await readCache(cachePath);
      assert.deepEqual(got, env);
    });
  });

  test('returns null when the cache file does not exist', async () => {
    await withTmpDir(async (dir) => {
      const got = await readCache(path.join(dir, 'missing.json'));
      assert.equal(got, null);
    });
  });
});

describe('readCache — top-level shape rejections', () => {
  test('rejects when repo is missing', async () => {
    await withTmpDir(async (dir) => {
      const cachePath = path.join(dir, 'cache.json');
      const env = { ...makeEmptyEnvelope() } as Partial<MaintainerTriage>;
      delete env.repo;
      await fs.writeFile(cachePath, JSON.stringify(env), 'utf-8');
      const got = await readCache(cachePath);
      assert.equal(got, null);
    });
  });

  test('rejects when tiers is not an array', async () => {
    await withTmpDir(async (dir) => {
      const cachePath = path.join(dir, 'cache.json');
      const env = { ...makeEmptyEnvelope(), tiers: 'not-an-array' };
      await fs.writeFile(cachePath, JSON.stringify(env), 'utf-8');
      const got = await readCache(cachePath);
      assert.equal(got, null);
    });
  });

  test('rejects when totals.issues_open is missing', async () => {
    await withTmpDir(async (dir) => {
      const cachePath = path.join(dir, 'cache.json');
      const env = {
        ...makeEmptyEnvelope(),
        totals: { prs_open: 0 },
      };
      await fs.writeFile(cachePath, JSON.stringify(env), 'utf-8');
      const got = await readCache(cachePath);
      assert.equal(got, null);
    });
  });
});

describe('readCache — deep TriageItem shape rejections (gascity-dashboard-3qy)', () => {
  test('rejects when first item is missing triage_assessment key (stale cache pre-are)', async () => {
    await withTmpDir(async (dir) => {
      const cachePath = path.join(dir, 'cache.json');
      const item = makeItem();
      const { triage_assessment: _drop, ...stale } = item;
      const env = makeEnvelope([stale as unknown as TriageItem]);
      await fs.writeFile(cachePath, JSON.stringify(env), 'utf-8');
      const got = await readCache(cachePath);
      assert.equal(got, null);
    });
  });

  test('rejects when first item is missing triage_score key', async () => {
    await withTmpDir(async (dir) => {
      const cachePath = path.join(dir, 'cache.json');
      const item = makeItem();
      const { triage_score: _drop, ...stale } = item;
      const env = makeEnvelope([stale as unknown as TriageItem]);
      await fs.writeFile(cachePath, JSON.stringify(env), 'utf-8');
      const got = await readCache(cachePath);
      assert.equal(got, null);
    });
  });

  test('rejects when first item is missing is_marked key', async () => {
    await withTmpDir(async (dir) => {
      const cachePath = path.join(dir, 'cache.json');
      const item = makeItem();
      const { is_marked: _drop, ...stale } = item;
      const env = makeEnvelope([stale as unknown as TriageItem]);
      await fs.writeFile(cachePath, JSON.stringify(env), 'utf-8');
      const got = await readCache(cachePath);
      assert.equal(got, null);
    });
  });

  test('accepts when first item has triage_assessment explicitly null (not missing)', async () => {
    await withTmpDir(async (dir) => {
      const cachePath = path.join(dir, 'cache.json');
      const env = makeEnvelope([makeItem({ triage_assessment: null })]);
      await writeCache(cachePath, env);
      const got = await readCache(cachePath);
      assert.deepEqual(got, env);
    });
  });

  test('spot-checks the first item inside a cluster when unclustered is empty', async () => {
    await withTmpDir(async (dir) => {
      const cachePath = path.join(dir, 'cache.json');
      const item = makeItem();
      const { triage_assessment: _drop, ...stale } = item;
      const env: MaintainerTriage = {
        computed_at: FIXED_ISO,
        repo: 'gastownhall/gascity',
        tiers: [
          {
            tier: 'stability',
            clusters: [
              {
                cluster_id: 'c1',
                files: ['a.ts'],
                items: [stale as unknown as TriageItem],
                lines_pending: 0,
              },
            ],
            unclustered: [],
          },
        ],
        totals: { issues_open: 1, prs_open: 0 },
      };
      await fs.writeFile(cachePath, JSON.stringify(env), 'utf-8');
      const got = await readCache(cachePath);
      assert.equal(got, null);
    });
  });
});
