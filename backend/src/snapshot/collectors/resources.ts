import { readFile } from 'node:fs/promises';
import {
  availableParallelism,
  cpus,
  freemem,
  loadavg,
  totalmem,
  uptime,
} from 'node:os';

import type { ResourceSummary } from 'gas-city-dashboard-shared';
import { SourceCache } from '../cache.js';

// Host-process resource sampler — gascity-dashboard-8nj. Pure node:os +
// /proc/meminfo; no upstream coupling, so this source never has a
// 'supervisor unreachable' failure mode. Ported from
// demo-dash src/server/collectors/resources.ts.

export const RESOURCE_CACHE_TTL_MS = 30 * 1000;

export interface CollectResourcesOptions {
  now?: () => Date;
  vcpuCount?: () => number;
  loadAverage?: () => [number, number, number];
  totalMemoryBytes?: () => number;
  availableMemoryBytes?: () => number;
  uptimeSeconds?: () => number;
  meminfoPath?: string;
}

export interface MeminfoSummary {
  totalBytes: number;
  availableBytes: number;
}

export interface CreateResourcesSourceCacheOptions extends CollectResourcesOptions {
  load?: () => Promise<ResourceSummary> | ResourceSummary;
  loadFixture?: () => Promise<ResourceSummary> | ResourceSummary;
  useFixture?: boolean;
}

const defaultMeminfoPath = '/proc/meminfo';

export function createResourcesSourceCache(
  options: CreateResourcesSourceCacheOptions = {},
): SourceCache<ResourceSummary> {
  return new SourceCache<ResourceSummary>({
    source: 'resources',
    ttlMs: RESOURCE_CACHE_TTL_MS,
    now: options.now,
    load: options.load ?? (() => collectResources(options)),
    loadFixture: options.loadFixture,
    useFixture: options.useFixture,
    // gascity-dashboard-fhj: this collector touches /proc/meminfo and
    // other local OS state. A raw fs error (e.g.
    // "ENOENT: no such file or directory, open /proc/meminfo") would
    // leak an OS-internal path to the browser via
    // GET /api/snapshot → SourceState.error. Collapse all collector
    // failures to a generic wire-shape message; the raw error is
    // preserved on stderr via the onError hook for operator debugging.
    sanitizeErrorMessage: () => 'resource collection failed',
    onError: logCollectorError,
  });
}

function logCollectorError(
  source: string,
  phase: 'load' | 'fixture',
  err: unknown,
): void {
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[snapshot] ${source}.${phase} failed: ${message}`);
}

export async function collectResources(
  options: CollectResourcesOptions = {},
): Promise<ResourceSummary> {
  const sampledAt = (options.now ?? (() => new Date()))().toISOString();
  const vcpuCount = positiveInteger((options.vcpuCount ?? defaultVcpuCount)(), 1);
  const loadAverage = normalizeLoadAverage((options.loadAverage ?? loadavg)());
  const totalMemory = options.totalMemoryBytes?.();
  const availableMemory = options.availableMemoryBytes?.();
  const meminfo =
    totalMemory === undefined || availableMemory === undefined
      ? await readMeminfo(options.meminfoPath ?? defaultMeminfoPath)
      : null;

  const totalBytes = nonNegativeNumber(totalMemory ?? meminfo?.totalBytes ?? totalmem());
  const availableBytes = Math.min(
    totalBytes,
    nonNegativeNumber(availableMemory ?? meminfo?.availableBytes ?? freemem()),
  );
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const memoryUtilization = totalBytes > 0 ? usedBytes / totalBytes : 0;
  const loadPerVcpu = loadAverage[0] / vcpuCount;

  return {
    vcpuCount,
    loadAverage,
    loadPerVcpu,
    memory: {
      totalBytes,
      usedBytes,
      availableBytes,
      utilization: memoryUtilization,
    },
    uptimeSeconds: nonNegativeNumber((options.uptimeSeconds ?? uptime)()),
    samples: [
      {
        sampledAt,
        vcpuCount,
        loadAverage,
        loadPerVcpu,
        memoryUsedBytes: usedBytes,
        memoryAvailableBytes: availableBytes,
        memoryUtilization,
      },
    ],
  };
}

export function parseMeminfo(content: string): MeminfoSummary | null {
  const values = new Map<string, number>();

  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_()]+):\s+(\d+)\s+kB\s*$/);
    if (match) {
      values.set(match[1] ?? '', Number(match[2]) * 1024);
    }
  }

  const totalBytes = values.get('MemTotal');
  const availableBytes = values.get('MemAvailable') ?? values.get('MemFree');

  if (totalBytes === undefined || availableBytes === undefined) {
    return null;
  }

  return {
    totalBytes,
    availableBytes,
  };
}

async function readMeminfo(path: string): Promise<MeminfoSummary | null> {
  try {
    return parseMeminfo(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function defaultVcpuCount(): number {
  try {
    return availableParallelism();
  } catch {
    return cpus().length;
  }
}

function normalizeLoadAverage(value: number[]): [number, number, number] {
  return [
    nonNegativeNumber(value[0] ?? 0),
    nonNegativeNumber(value[1] ?? 0),
    nonNegativeNumber(value[2] ?? 0),
  ];
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeNumber(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
