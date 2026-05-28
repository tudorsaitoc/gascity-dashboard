import { ExecError } from '../exec.js';
import { errorMessage } from '../logging.js';

export function parseJsonArray<T>(stdout: string, source: string): T[] {
  if (stdout.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`${source} did not return an array`);
    }
    return parsed as T[];
  } catch (err) {
    throw new ExecError(
      `${source} returned unparseable JSON: ${errorMessage(err)}`,
      'spawn',
    );
  }
}
