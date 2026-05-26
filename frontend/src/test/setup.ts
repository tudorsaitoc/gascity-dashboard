import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest';

let warnSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;
const processWarnings: string[] = [];

beforeAll(() => {
  process.on('warning', trackProcessWarning);
  installDeterministicStorage();
});

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    throw new Error(`Unexpected console.warn: ${formatConsoleArgs(args)}`);
  });
  infoSpy = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    throw new Error(`Unexpected console.info: ${formatConsoleArgs(args)}`);
  });
});

afterEach(() => {
  warnSpy.mockRestore();
  infoSpy.mockRestore();

  if (processWarnings.length > 0) {
    const warnings = processWarnings.splice(0).join('\n');
    throw new Error(`Unexpected process warning:\n${warnings}`);
  }
});

afterAll(() => {
  process.off('warning', trackProcessWarning);
});

function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg)))
    .join(' ');
}

function trackProcessWarning(warning: Error): void {
  processWarnings.push(`${warning.name}: ${warning.message}`);
}

function installDeterministicStorage(): void {
  try {
    if (typeof window.localStorage?.clear === 'function') {
      return;
    }
  } catch {
    // Opaque jsdom origins throw here; tests should still get storage.
  }

  const storage = new MemoryStorage();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
}

class MemoryStorage implements Storage {
  readonly #items = new Map<string, string>();

  get length(): number {
    return this.#items.size;
  }

  clear(): void {
    this.#items.clear();
  }

  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.#items.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.#items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }
}
