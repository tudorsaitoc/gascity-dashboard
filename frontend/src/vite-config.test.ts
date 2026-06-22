// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import viteConfig, {
  BACKEND_TARGET,
  configureBackendDevProxy,
  resolveTailnetDevServer,
} from '../vite.config';

describe('vite dev proxy config', () => {
  it('rewrites Origin for both dashboard api and supervisor transport writes', () => {
    const proxy = viteConfig.server?.proxy;
    expect(proxy).toBeTypeOf('object');
    if (typeof proxy !== 'object' || proxy === null || Array.isArray(proxy)) {
      throw new Error('vite proxy config missing');
    }

    expect(proxy['/api']).toMatchObject({
      target: BACKEND_TARGET,
      changeOrigin: true,
      configure: configureBackendDevProxy,
    });
    expect(proxy['/gc-supervisor']).toMatchObject({
      target: BACKEND_TARGET,
      changeOrigin: true,
      configure: configureBackendDevProxy,
    });
  });

  it('rewrites browser Origin to the backend origin when present', () => {
    let listener: ((req: ProxyRequestDouble) => void) | undefined;
    configureBackendDevProxy({
      on(event, next) {
        expect(event).toBe('proxyReq');
        listener = next;
      },
    });
    const proxyReq = {
      hasHeader: vi.fn((name: string) => name.toLowerCase() === 'origin'),
      setHeader: vi.fn(),
    };

    if (listener === undefined) throw new Error('proxyReq listener not registered');
    listener(proxyReq);

    expect(proxyReq.setHeader).toHaveBeenCalledWith('Origin', BACKEND_TARGET);
  });

  it('leaves originless requests untouched', () => {
    let listener: ((req: ProxyRequestDouble) => void) | undefined;
    configureBackendDevProxy({
      on(_event, next) {
        listener = next;
      },
    });
    const proxyReq = {
      hasHeader: vi.fn(() => false),
      setHeader: vi.fn(),
    };

    if (listener === undefined) throw new Error('proxyReq listener not registered');
    listener(proxyReq);

    expect(proxyReq.setHeader).not.toHaveBeenCalled();
  });
});

describe('resolveTailnetDevServer', () => {
  afterEach(() => {
    delete process.env.DEV_TAILNET_HOST;
    delete process.env.DEV_TAILNET_PORT;
  });

  it('returns no overrides when DEV_TAILNET_HOST is unset (default loopback dev)', () => {
    expect(resolveTailnetDevServer()).toEqual({});
  });

  it('returns no overrides when DEV_TAILNET_HOST is empty', () => {
    process.env.DEV_TAILNET_HOST = '';
    expect(resolveTailnetDevServer()).toEqual({});
  });

  it('allows the tailnet host and points HMR at the default serve port over wss', () => {
    process.env.DEV_TAILNET_HOST = 'host.example.ts.net';
    expect(resolveTailnetDevServer()).toEqual({
      allowedHosts: ['host.example.ts.net'],
      hmr: { protocol: 'wss', host: 'host.example.ts.net', clientPort: 5174 },
    });
  });

  it('honors an explicit DEV_TAILNET_PORT for the HMR client port', () => {
    process.env.DEV_TAILNET_HOST = 'host.example.ts.net';
    process.env.DEV_TAILNET_PORT = '8443';
    expect(resolveTailnetDevServer()).toMatchObject({
      hmr: { clientPort: 8443 },
    });
  });

  it('throws on a non-numeric DEV_TAILNET_PORT rather than silently defaulting', () => {
    process.env.DEV_TAILNET_HOST = 'host.example.ts.net';
    process.env.DEV_TAILNET_PORT = 'not-a-port';
    expect(() => resolveTailnetDevServer()).toThrow(/DEV_TAILNET_PORT/);
  });

  it('throws on an out-of-range DEV_TAILNET_PORT', () => {
    process.env.DEV_TAILNET_HOST = 'host.example.ts.net';
    process.env.DEV_TAILNET_PORT = '70000';
    expect(() => resolveTailnetDevServer()).toThrow(/DEV_TAILNET_PORT/);
  });

  it('throws on a leading-numeric DEV_TAILNET_PORT instead of partial-parsing it', () => {
    // Number.parseInt('5174abc') would be 5174; the strict parse must reject it.
    process.env.DEV_TAILNET_HOST = 'host.example.ts.net';
    process.env.DEV_TAILNET_PORT = '5174abc';
    expect(() => resolveTailnetDevServer()).toThrow(/DEV_TAILNET_PORT/);
  });

  it('throws on a wildcard/sentinel DEV_TAILNET_HOST that would widen the host guard', () => {
    for (const bad of ['*', 'true', '0.0.0.0', 'localhost']) {
      process.env.DEV_TAILNET_HOST = bad;
      expect(() => resolveTailnetDevServer(), bad).toThrow(/DEV_TAILNET_HOST/);
    }
  });

  it('trims surrounding whitespace from DEV_TAILNET_HOST', () => {
    process.env.DEV_TAILNET_HOST = '  host.example.ts.net  ';
    expect(resolveTailnetDevServer()).toMatchObject({ allowedHosts: ['host.example.ts.net'] });
  });
});

interface ProxyRequestDouble {
  hasHeader(name: string): boolean;
  setHeader(name: string, value: string): void;
}
