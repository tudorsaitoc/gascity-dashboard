import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getCached, invalidate } from "../api/cache";
import { useCachedData } from "./useCachedData";

afterEach(() => {
  cleanup();
  invalidate("");
});

describe("useCachedData", () => {
  it("does not let a stale fetch overwrite state after the cache key changes", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const fetchers: Record<string, () => Promise<string>> = {
      first: vi.fn(() => first.promise),
      second: vi.fn(() => second.promise),
    };

    const { result, rerender } = renderHook(
      ({ cacheKey }: { cacheKey: string }) =>
        useCachedData(cacheKey, fetcherFor(fetchers, cacheKey)),
      { initialProps: { cacheKey: "first" } },
    );

    expect(result.current.loading).toBe(true);

    rerender({ cacheKey: "second" });

    await act(async () => {
      second.resolve("second result");
      await second.promise;
    });
    await waitFor(() => expect(result.current.data).toBe("second result"));

    await act(async () => {
      first.resolve("first result");
      await first.promise;
    });

    expect(result.current.data).toBe("second result");
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("does not let a stale same-key fetch overwrite the cache slot", async () => {
    const slow = deferred<string>();
    const fast = deferred<string>();
    const cacheKey = "run-run:active";

    const { result } = renderHook(() =>
      useCachedData(cacheKey, () => slow.promise, {
        refreshFetcher: () => fast.promise,
      }),
    );

    let refreshPromise: Promise<void> | undefined;
    act(() => {
      refreshPromise = result.current.refresh();
    });

    await act(async () => {
      fast.resolve("fresh result");
      await refreshPromise;
    });
    await waitFor(() => expect(result.current.data).toBe("fresh result"));
    expect(getCached<string>(cacheKey)).toBe("fresh result");

    await act(async () => {
      slow.resolve("stale result");
      await slow.promise;
    });

    expect(result.current.data).toBe("fresh result");
    expect(getCached<string>(cacheKey)).toBe("fresh result");
  });

  it("reports the latest fetch failure through onError", async () => {
    const onError = vi.fn();
    const failure = new Error("network down");

    const { result } = renderHook(() =>
      useCachedData("broken", () => Promise.reject(failure), { onError }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBe("network down");
    expect(onError).toHaveBeenCalledWith(failure);
  });
});

function fetcherFor<T>(
  fetchers: Record<string, () => Promise<T>>,
  key: string,
) {
  const fetcher = fetchers[key];
  if (!fetcher) throw new Error(`missing fetcher for ${key}`);
  return fetcher;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
