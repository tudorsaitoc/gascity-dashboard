import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { errorMessage, type MaintainerTriage, type TriageItem } from 'gas-city-dashboard-shared';
import { api } from '../api/client';
import { setCached } from '../api/cache';
import { reportClientError } from '../lib/clientErrorReporting';
import {
  buildSlingRequests,
  dispatchSlings,
  selectionKey,
  useSlingSuccess,
  type MaintainerSlingIntent,
  type SlingSuccess,
} from './maintainerSelection';

export const MAINTAINER_CACHE_KEY = 'maintainer-triage';

const COMPONENT = 'MaintainerPage';
const TRIAGE_TARGET_LABEL = 'triage agent';
const DRAFT_TARGET_LABEL = 'draft agent';

type RefreshFn = () => Promise<void>;

export function useMaintainerEventRefresh(refresh: RefreshFn): void {
  useEffect(() => {
    const es = new EventSource('/api/maintainer/events');
    const onRefresh = () => {
      void refresh();
    };
    es.addEventListener('refreshed', onRefresh);
    es.onerror = () => {
      void reportClientError({
        component: COMPONENT,
        operation: 'maintainerEvents',
        message: `event stream error, readyState ${es.readyState}`,
      });
    };
    return () => {
      es.removeEventListener('refreshed', onRefresh);
      es.onerror = null;
      es.close();
    };
  }, [refresh]);
}

export interface MaintainerRefreshAction {
  readonly refreshing: boolean;
  readonly refreshError: string | null;
  readonly handleRefresh: () => Promise<void>;
}

export function useMaintainerRefreshAction(refresh: RefreshFn): MaintainerRefreshAction {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const fresh = await api.maintainerRefresh();
      setCached<MaintainerTriage>(MAINTAINER_CACHE_KEY, fresh);
      await refresh();
    } catch (err) {
      const message = errorMessage(err);
      setRefreshError(message);
      void reportClientError({
        component: COMPONENT,
        operation: 'maintainerRefresh',
        message,
      });
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  return { refreshing, refreshError, handleRefresh };
}

export interface MaintainerSlingAction {
  readonly slinging: MaintainerSlingIntent | null;
  readonly slingError: string | null;
  readonly slingSuccess: SlingSuccess | null;
  readonly handleSend: (intent: MaintainerSlingIntent) => Promise<void>;
  readonly clearSlingFeedback: () => void;
}

export function useMaintainerSlingAction({
  selection,
  allItems,
  setSelection,
}: {
  readonly selection: ReadonlySet<string>;
  readonly allItems: ReadonlyArray<TriageItem>;
  readonly setSelection: Dispatch<SetStateAction<Set<string>>>;
}): MaintainerSlingAction {
  const [slinging, setSlinging] = useState<MaintainerSlingIntent | null>(null);
  const [slingError, setSlingError] = useState<string | null>(null);
  const { success: slingSuccess, setSuccess: setSlingSuccess, clearSuccess: clearSlingSuccess } =
    useSlingSuccess();

  const clearSlingFeedback = useCallback(() => {
    setSlingError(null);
    clearSlingSuccess();
  }, [clearSlingSuccess]);

  const handleSend = useCallback(async (intent: MaintainerSlingIntent) => {
    const successLabel =
      intent === 'triage' ? TRIAGE_TARGET_LABEL : DRAFT_TARGET_LABEL;
    setSlinging(intent);
    setSlingError(null);
    clearSlingSuccess();
    try {
      const requests = buildSlingRequests(selection, allItems, intent);
      const summary = await dispatchSlings(requests, (req) => api.maintainerSling(req));
      if (summary.failed === 0) {
        setSelection(new Set());
        if (summary.succeeded > 0) {
          setSlingSuccess({ count: summary.succeeded, target: successLabel });
        }
      } else {
        const remaining = new Set<string>();
        for (const outcome of summary.outcomes) {
          if (!outcome.ok) remaining.add(selectionKey(outcome.request));
        }
        setSelection(remaining);
        setSlingError(
          `${summary.failed} of ${summary.outcomes.length} failed: ${summary.outcomes.find((outcome) => !outcome.ok)?.error ?? 'unknown error'}`,
        );
        if (summary.succeeded > 0) {
          setSlingSuccess({ count: summary.succeeded, target: successLabel });
        }
      }
    } catch (err) {
      const message = errorMessage(err);
      setSlingError(message);
      void reportClientError({
        component: COMPONENT,
        operation: `maintainerSling.${intent}`,
        message,
      });
    } finally {
      setSlinging(null);
    }
  }, [allItems, clearSlingSuccess, selection, setSelection, setSlingSuccess]);

  return { slinging, slingError, slingSuccess, handleSend, clearSlingFeedback };
}
