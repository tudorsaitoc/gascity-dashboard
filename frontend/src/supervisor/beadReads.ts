import type {
  Bead,
  GetV0CityByCityNameBeadsData,
  ListBodyBead,
} from '../generated/gc-supervisor-client/types.gen';
import { getActiveCity } from '../api/cityBase';
import { SupervisorApiError, supervisorApi } from './client';

export type SupervisorBead = Bead;

export interface SupervisorBeadList extends Omit<ListBodyBead, 'items' | 'total'> {
  items: SupervisorBead[];
  total: number;
  upstream_total?: number;
  upstream_fetched: number;
  fetch_limit: number;
}

const BEADS_FETCH_LIMIT = 1000;
const DETAIL_FALLBACK_FETCH_LIMIT = 2000;
const ENGINEERING_BEAD_TYPES: ReadonlySet<string> = new Set([
  'feature',
  'bug',
  'task',
  'docs',
]);

export async function listSupervisorBeads(
  showAll = false,
  rigFilter = '',
): Promise<SupervisorBeadList> {
  const cityName = activeCityOrThrow('list supervisor beads');
  const query: NonNullable<GetV0CityByCityNameBeadsData['query']> = {
    limit: BEADS_FETCH_LIMIT,
    ...(rigFilter.length === 0 ? {} : { rig: rigFilter }),
  };
  const list = await supervisorApi().listBeads(cityName, query);
  const items = list.items ?? [];
  const filtered = showAll ? items : items.filter(defaultBeadFilter);
  const upstreamTotal = countAsNumber(list.total);
  return {
    ...list,
    items: filtered,
    total: filtered.length,
    ...(upstreamTotal === undefined ? {} : { upstream_total: upstreamTotal }),
    upstream_fetched: items.length,
    fetch_limit: BEADS_FETCH_LIMIT,
  };
}

export async function fetchSupervisorBead(id: string): Promise<SupervisorBead> {
  const cityName = activeCityOrThrow('fetch supervisor bead');
  try {
    return await supervisorApi().getBead(cityName, id);
  } catch (err) {
    if (!(err instanceof SupervisorApiError) || err.status !== 404) throw err;

    const list = await supervisorApi().listBeads(cityName, {
      limit: DETAIL_FALLBACK_FETCH_LIMIT,
    });
    const hit = (list.items ?? []).find((bead) => bead.id === id);
    if (hit !== undefined) return hit;
    throw err;
  }
}

function defaultBeadFilter(bead: SupervisorBead): boolean {
  if (!ENGINEERING_BEAD_TYPES.has(bead.issue_type)) return false;
  if (Array.isArray(bead.labels) && bead.labels.some((label) => label.startsWith('gc:'))) {
    return false;
  }
  return true;
}

function activeCityOrThrow(operation: string): string {
  const cityName = getActiveCity();
  if (cityName === null) {
    throw new Error(`${operation} called before an active city was resolved`);
  }
  return cityName;
}

function countAsNumber(value: ListBodyBead['total']): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return undefined;
}
