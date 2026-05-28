/**
 * Races a promise against a TimeoutError-named rejection so callers can
 * surface a 504 through the shared timeout classifier. The underlying
 * operation is not cancelled; it is left to settle on its own timer.
 */
export function raceWithTimeout<T>(
  promise: Promise<T>,
  ms: number,
  operation = 'operation',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`${operation} timed out after ${ms}ms`);
      err.name = 'TimeoutError';
      reject(err);
    }, ms);
    timer.unref();
    promise.then(
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
