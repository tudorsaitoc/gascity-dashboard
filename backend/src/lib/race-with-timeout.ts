// Race a Promise against a TimeoutError-named rejection so the caller can
// surface a 504 (via GcClient.isTimeoutError) when the underlying call would
// otherwise sit on a generous default timeout.
//
// Hoisted out of `routes/sessions.ts` into the shared lib/ during PR-B1 so
// the maintainer module is self-contained (docs/maintainer-coupling.md C3) —
// it no longer reaches into another route's exports for a generic timer
// utility. `routes/sessions.ts` re-imports from here.
//
// The underlying Promise is NOT cancelled (gc-client's awaitWithSignal would
// convert a caller-supplied AbortSignal into AbortError, which the 504 path
// doesn't recognise); it's left to settle on its own timer. Node releases
// the socket on completion, and single-flight coalescing means concurrent
// callers (e.g. the snapshot collector) still benefit from the same fetch.

/** Race a Promise against a TimeoutError-named rejection after `ms` ms. */
export function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`operation timed out after ${ms}ms`);
      err.name = 'TimeoutError';
      reject(err);
    }, ms);
    // Match the rest of the backend (worker.ts, dolt.ts, server.ts): an
    // unref'd timer doesn't block graceful shutdown on SIGTERM.
    timer.unref();
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
