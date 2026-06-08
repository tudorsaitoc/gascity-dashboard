import { useMemo } from 'react';
import { type SourceStatus } from 'gas-city-dashboard-shared';
import { api, formatApiError } from '../api/client';
import { getActiveCity } from '../api/cityBase';
import { type OperatorConfig } from '../contexts/OperatorConfigContext';
import { useCachedData } from '../hooks/useCachedData';
import { listAgentPendingInteractions } from '../supervisor/agentPending';
import { listSupervisorBeads } from '../supervisor/beadReads';
import { supervisorApi, supervisorApiForRequestBudget } from '../supervisor/client';
import { DEFAULT_MAIL_HISTORY_LIMIT, listSupervisorMail } from '../supervisor/mailReads';
import { loadSupervisorRunSummarySource } from '../supervisor/runSummary';
import type { AttentionContributor } from './compose';
import {
  createAttentionContributors,
  GC_ESCALATION_LABEL,
  type ActivityAttentionFacts,
  type AgentsAttentionFacts,
  type AttentionContributorFacts,
  type BeadsAttentionFacts,
  type HealthAttentionFacts,
  type MailAttentionFacts,
  type MaintainerAttentionFacts,
  type RunsAttentionFacts,
} from './registry';

const ATTENTION_LIST_LIMIT = 1000;
const ACTIVITY_EVENT_FETCH_LIMIT = 100;
const ACTIVITY_EVENT_WINDOW = '24h';
const HEALTH_ATTENTION_SUPERVISOR_TIMEOUT_MS = 2_500;

export function useLiveAttentionContributors(
  enabledModules: readonly string[] | null,
  operator: OperatorConfig,
): readonly AttentionContributor[] {
  const cityName = getActiveCity();
  const cacheSuffix = cityName ?? 'no-city';
  const maintainerEnabled = enabledModules?.includes('maintainer') ?? false;
  // The decision label + operator wire alias come from /config
  // (gascity-dashboard-bhvn). Encode them into the relevant cache keys so a
  // pre-config fallback → real-config transition refetches with the resolved
  // identity (useCachedData only refetches on key change).
  const { decisionLabel, operatorWireAlias } = operator;
  const runs = useCachedData<RunsAttentionFacts>(`attention:runs:${cacheSuffix}`, () =>
    fetchRunsAttention(cityName),
  );
  const agents = useCachedData<AgentsAttentionFacts>(`attention:agents:${cacheSuffix}`, () =>
    fetchAgentsAttention(cityName),
  );
  const beads = useCachedData<BeadsAttentionFacts>(
    `attention:beads:${cacheSuffix}:${decisionLabel}`,
    () => fetchBeadsAttention(cityName, decisionLabel),
  );
  const mail = useCachedData<MailAttentionFacts>(
    `attention:mail:${cacheSuffix}:${operatorWireAlias}`,
    () => fetchMailAttention(cityName, operator),
  );
  const activity = useCachedData<ActivityAttentionFacts>(`attention:activity:${cacheSuffix}`, () =>
    fetchActivityAttention(cityName),
  );
  const health = useCachedData<HealthAttentionFacts>(`attention:health:${cacheSuffix}`, () =>
    fetchHealthAttention(cityName),
  );
  const maintainer = useCachedData<MaintainerAttentionFacts>(
    `attention:maintainer:${cacheSuffix}:${maintainerEnabled ? 'enabled' : 'disabled'}`,
    () => fetchMaintainerAttention(cityName, maintainerEnabled),
  );

  return useMemo(
    () =>
      createAttentionContributors(
        compactFacts({
          activity: activity.data,
          agents: agents.data,
          beads: beads.data,
          health: health.data,
          mail: mail.data,
          maintainer: maintainer.data,
          runs: withRunsFreshness(runs.data, runs.error, runs.fetchedAt),
        }),
      ),
    [
      activity.data,
      agents.data,
      beads.data,
      health.data,
      mail.data,
      maintainer.data,
      runs.data,
      runs.error,
      runs.fetchedAt,
    ],
  );
}

/**
 * Stamp the runs read's provenance + fetch timestamp onto its facts so the
 * registry can carry them onto `unavailable`-tier items. A degraded read can
 * then be aged (gascity-dashboard issue-88 follow-up) rather than rendered as
 * current truth. The cache is event-refreshed (no TTL), so provenance is the
 * coarse read status — `error` on failure, otherwise `fresh`; `fetchedAt`
 * carries the exact read time for any age comparison.
 */
function withRunsFreshness(
  facts: RunsAttentionFacts | undefined,
  error: string | null,
  fetchedAt: string | undefined,
): RunsAttentionFacts | undefined {
  if (facts === undefined) return undefined;
  const provenance: SourceStatus =
    error !== null || (facts.error !== undefined && facts.error.length > 0) ? 'error' : 'fresh';
  return { ...facts, provenance, ...(fetchedAt === undefined ? {} : { fetchedAt }) };
}

async function fetchRunsAttention(cityName: string | null): Promise<RunsAttentionFacts> {
  if (cityName === null) return {};
  // gascity-dashboard-2j8e.6: the badge must derive its genuinely-blocked count
  // from the SAME COMPLETE snapshot the /runs page renders, not just the same
  // selector. #95 (2j8e.2) unified the selector (selectBlockedRuns) but left the
  // badge on the cheap preview source while the page upgrades to the full source
  // on its first refresh — so the two read DIFFERENT-completeness snapshots and
  // the badge persistently undercounted (operator saw page Blocked(4), nav badge
  // empty). The preview budget (2.5s) lets the recent-run fan-out time out under
  // a slow supervisor, dropping the very lanes that map to `phase === 'blocked'`;
  // the page's full source (30s budget + session enrichment) loads them. Reading
  // the full source here makes the badge's blocked set as complete as the page's,
  // so the counts agree in steady state rather than only "by construction" over a
  // snapshot neither side actually shares.
  //
  // The formula feed (the pre-#95 source) stays dropped: it counted phantom
  // feed-only roots and flapped on partial fan-outs.
  //
  // This still refetches under the attention cache key rather than sharing the
  // page's `runs:summary:*` entry, so on /runs the fan-out runs twice. The fetch
  // is mount-driven (no recurring poll), so the cost is bounded to cold load /
  // city switch; lifting the run summary into one shared subscription that both
  // the header badge and the page read is the proper follow-up (a cross-cutting
  // change kept out of this focused parity fix).
  const source = await loadSupervisorRunSummarySource();
  if (source.status === 'error') {
    return { error: source.error };
  }
  return { summary: source.data };
}

async function fetchAgentsAttention(cityName: string | null): Promise<AgentsAttentionFacts> {
  if (cityName === null) return {};
  try {
    const list = await supervisorApi().listAgents(cityName);
    const facts: AgentsAttentionFacts = {
      items: list.items ?? [],
      partial: list.partial === true,
    };
    try {
      const sessions = await supervisorApi().listSessions(cityName);
      facts.pendingInteractions = await listAgentPendingInteractions(
        list.items ?? [],
        sessions.items ?? [],
      );
    } catch (err) {
      facts.pendingError = formatApiError(err, 'agent pending state unavailable');
    }
    return facts;
  } catch (err) {
    return { error: formatApiError(err, 'agent list unavailable') };
  }
}

async function fetchBeadsAttention(
  cityName: string | null,
  decisionLabel: string,
): Promise<BeadsAttentionFacts> {
  if (cityName === null) return { decisionLabel };
  // Three independent reads: the general bead list (capped) and two dedicated
  // label+status-filtered queues — the mayor-decision queue and the escalation
  // queue. Both queues bypass the general list's gc:-label filter and are always
  // complete. Settled separately so one failing does not blank the others — the
  // decision queue, the escalation queue, and generic bead alerts are distinct
  // signals (gascity-dashboard-2j8e.3).
  const [list, decisions, escalations] = await Promise.allSettled([
    listSupervisorBeads({ limit: ATTENTION_LIST_LIMIT }),
    listDecisionBeads(cityName, decisionLabel),
    listEscalationBeads(cityName),
  ]);
  const facts: BeadsAttentionFacts = { nowMs: Date.now(), decisionLabel };
  if (list.status === 'fulfilled') {
    facts.items = list.value.items;
    facts.partial = list.value.partial === true;
  } else {
    facts.error = formatApiError(list.reason, 'bead list unavailable');
  }
  if (decisions.status === 'fulfilled') {
    facts.decisions = decisions.value.items ?? [];
  } else {
    facts.decisionsError = formatApiError(decisions.reason, 'decision queue unavailable');
  }
  if (escalations.status === 'fulfilled') {
    facts.escalations = escalations.value.items ?? [];
  } else {
    facts.escalationsError = formatApiError(escalations.reason, 'escalation queue unavailable');
  }
  return facts;
}

async function listDecisionBeads(cityName: string, decisionLabel: string) {
  return supervisorApi().listBeads(cityName, {
    label: decisionLabel,
    status: 'open',
  });
}

async function listEscalationBeads(cityName: string) {
  return supervisorApi().listBeads(cityName, {
    label: GC_ESCALATION_LABEL,
    status: 'open',
  });
}

async function fetchMailAttention(
  cityName: string | null,
  operator: OperatorConfig,
): Promise<MailAttentionFacts> {
  if (cityName === null) return { operatorAlias: operator.operatorWireAlias };
  try {
    const list = await listSupervisorMail(
      'inbox',
      operator.operatorAlias,
      operator,
      DEFAULT_MAIL_HISTORY_LIMIT,
    );
    return {
      items: list.items ?? [],
      nowMs: Date.now(),
      operatorAlias: operator.operatorWireAlias,
      partial: list.partial === true,
    };
  } catch (err) {
    return {
      operatorAlias: operator.operatorWireAlias,
      error: formatApiError(err, 'mail list unavailable'),
    };
  }
}

async function fetchActivityAttention(cityName: string | null): Promise<ActivityAttentionFacts> {
  const [deploys, events] = await Promise.allSettled([
    api.listBuilds(),
    cityName === null
      ? Promise.resolve(null)
      : supervisorApi().listEvents(cityName, {
          limit: ACTIVITY_EVENT_FETCH_LIMIT,
          since: ACTIVITY_EVENT_WINDOW,
        }),
  ]);
  const facts: ActivityAttentionFacts = {};

  if (deploys.status === 'fulfilled') {
    facts.deploys = deploys.value;
  } else {
    facts.deploysError = formatApiError(deploys.reason, 'deploy activity unavailable');
  }

  if (events.status === 'fulfilled') {
    if (events.value !== null) {
      facts.events = events.value.items ?? [];
      facts.eventsPartial = events.value.partial === true;
      if (events.value.partial_errors !== null && events.value.partial_errors !== undefined) {
        facts.eventsDegraded = events.value.partial_errors.join('; ');
      }
    }
  } else {
    facts.eventsError = formatApiError(events.reason, 'event history unavailable');
  }

  return facts;
}

async function fetchHealthAttention(cityName: string | null): Promise<HealthAttentionFacts> {
  if (cityName === null) return {};
  const [system, supervisor, trend] = await Promise.allSettled([
    api.systemHealth(),
    supervisorApiForRequestBudget(HEALTH_ATTENTION_SUPERVISOR_TIMEOUT_MS).cityHealth(cityName),
    api.doltTrend(),
  ]);
  const facts: HealthAttentionFacts = {};
  const dashboardErrors: string[] = [];

  if (system.status === 'fulfilled') {
    facts.system = system.value;
  } else {
    dashboardErrors.push(formatApiError(system.reason, 'dashboard health unavailable'));
  }

  if (supervisor.status === 'fulfilled') {
    facts.supervisor = { status: 'available', data: supervisor.value };
  } else {
    facts.supervisor = {
      status: 'unavailable',
      error: formatApiError(supervisor.reason, 'supervisor health unavailable'),
    };
  }

  if (trend.status === 'fulfilled') {
    facts.trend = trend.value;
  } else {
    dashboardErrors.push(formatApiError(trend.reason, 'dolt-noms trend unavailable'));
  }

  if (dashboardErrors.length > 0) {
    facts.dashboardError = dashboardErrors.join('; ');
  }
  return facts;
}

async function fetchMaintainerAttention(
  cityName: string | null,
  enabled: boolean,
): Promise<MaintainerAttentionFacts> {
  if (!enabled || cityName === null) return { enabled: false };
  try {
    return {
      enabled: true,
      nowMs: Date.now(),
      triage: await api.maintainerTriage(),
    };
  } catch (err) {
    return {
      enabled: true,
      error: formatApiError(err, 'maintainer triage unavailable'),
    };
  }
}

function compactFacts(facts: {
  [K in keyof AttentionContributorFacts]: AttentionContributorFacts[K] | undefined;
}): AttentionContributorFacts {
  const out: AttentionContributorFacts = {};
  for (const [key, value] of Object.entries(facts)) {
    if (value !== undefined) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}
