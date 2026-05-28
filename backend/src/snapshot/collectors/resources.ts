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
import { LOG_COMPONENT, errorMessage, logWarn } from '../../logging.js';

// Host-process resource sampler — gascity-dashboard-8nj. Pure node:os +
// /proc/meminfo; no upstream coupling, so this source never has a
// 'supervisor unreachable' failure mode.

export const RESOURCE_CACHE_TTL_MS = 30 * 1000;

export interface CollectResourcesOptions {
  now?: (() => Date) | undefined;
  vcpuCount?: (() => number) | undefined;
  loadAverage?: (() => [number, number, number]) | undefined;
  totalMemoryBytes?: (() => number) | undefined;
  availableMemoryBytes?: (() => number) | undefined;
  uptimeSeconds?: (() => number) | undefined;
  meminfoPath?: string | undefined;
}

export interface MeminfoSummary {
  totalBytes: number;
  availableBytes: number;
}

export interface CreateResourcesSourceCacheOptions extends CollectResourcesOptions {
  load?: (() => Promise<ResourceSummary> | ResourceSummary) | undefined;
  loadFixture?: (() => Promise<ResourceSummary> | ResourceSummary) | undefined;
  useFixture?: boolean | undefined;
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
    // gascity-dashboard-fhj / -4r5: this collector touches
    // /proc/meminfo and other local OS state. A raw fs error (e.g.
    // "ENOENT: no such file or directory, open /proc/meminfo") would
    // leak an OS-internal path to the browser via
    // GET /api/snapshot → SourceState.error. We rely on the
    // SourceCache default sanitizer to collapse all collector
    // failures to "resources collection failed"; the raw error is
    // preserved on stderr via the onError hook for operator debugging.
    onError: logCollectorError,
  });
}

function logCollectorError(
  source: string,
  phase: 'load' | 'fixture',
  err: unknown,
): void {
  // GUARDRAIL (gascity-dashboard-tva): err.message can embed OS paths. Today
  // this lands in journalctl, read only by the local operator, so it stays
  // raw for debug fidelity. If off-host log shipping is ever wired (loki,
  // datadog, journal-upload), the path redaction that gascity-dashboard-fhj
  // stripped from the wire must be re-introduced AT THE LOGGER LAYER (a
  // structured logger with path-like field redaction, or a forwarder
  // transform) — NOT here. Per-site redaction is the wrong layer; it forces
  // every log call to remember the policy.
  logWarn(LOG_COMPONENT.snapshot, `${source}.${phase} failed: ${errorMessage(err)}`);
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
  } catch (err) {
    logWarn(LOG_COMPONENT.snapshot, `resources.meminfo read failed: ${errorMessage(err)}`);
    return null;
  }
}

function defaultVcpuCount(): number {
  try {
    return availableParallelism();
  } catch (err) {
    logWarn(LOG_COMPONENT.snapshot, `resources.availableParallelism failed: ${errorMessage(err)}`);
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
