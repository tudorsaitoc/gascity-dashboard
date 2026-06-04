import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiClientError } from './client';

describe('api client error handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('surfaces non-JSON error bodies instead of replacing them with status text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('plain upstream failure', {
            status: 502,
            statusText: 'Bad Gateway',
          }),
      ),
    );

    await expect(api.config()).rejects.toMatchObject({
      status: 502,
      message: 'plain upstream failure',
    });
  });

  it('preserves structured API error kind and message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'bad scope', kind: 'validation' }), {
            status: 400,
            statusText: 'Bad Request',
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    await expect(api.config()).rejects.toBeInstanceOf(ApiClientError);
    await expect(api.config()).rejects.toMatchObject({
      status: 400,
      message: 'bad scope',
      kind: 'validation',
    });
  });

  it('rejects malformed successful response bodies at the frontend API edge', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ cityName: 'demo-city' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    await expect(api.config()).rejects.toMatchObject({
      name: 'ApiResponseDecodeError',
      message: expect.stringContaining('config.cityRoot must be a string'),
    });
  });
});
