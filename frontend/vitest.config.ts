import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Vitest config kept separate from vite.config.ts so the dev server
// stays focused on serving the app. Tests run in jsdom; localStorage
// is the only DOM API our hooks touch directly.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    globals: false,
  },
});
