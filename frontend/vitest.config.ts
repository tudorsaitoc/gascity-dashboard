import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Vitest config kept separate from vite.config.ts so the dev server
// stays focused on serving the app. Tests run in jsdom; localStorage
// is the only DOM API our hooks touch directly.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: {
        url: 'http://127.0.0.1/',
      },
    },
    include: ['src/**/*.test.{ts,tsx}'],
    globals: false,
    setupFiles: ['src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      // Ratchet floor, not aspiration: thresholds sit ~5 points below the
      // measured baseline (89.02 lines / 77.12 branches / 86.4 stmts /
      // 87.1 funcs as of 2026-06). Raise them as real coverage rises;
      // never lower them to admit a regression.
      thresholds: {
        lines: 84,
        branches: 72,
        statements: 81,
        functions: 82,
      },
    },
  },
});
