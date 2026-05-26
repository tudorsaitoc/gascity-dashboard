// Headless screenshot harness for design iteration.
//
// Usage:
//   node scripts/snap.mjs            # snap all routes × both themes
//   node scripts/snap.mjs agents     # snap one route, both themes
//   node scripts/snap.mjs agents light  # one route, one theme
//
// SSE routes (/agents, /workflows) auto-wait longer so the live-connection
// badge settles to 'live' before the shot. SNAP_WAIT_MS=<ms> overrides the
// per-route wait for every route.
//
// Output: /tmp/cp-snaps/<theme>-<route>.png at 1440×900 (MBP-ish).

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { argv, env, exit } from 'node:process';

const BASE = 'http://127.0.0.1:5174';
const OUT  = '/tmp/cp-snaps';

const ROUTES = ['agents', 'beads', 'workflows', 'mail', 'activity', 'health', 'maintainer'];
const THEMES = ['light', 'dark'];

// Routes that subscribe to /api/events/stream via useGcEventRefresh and render
// an SseIndicator. Their badge starts amber ('connecting') and only flips green
// ('live') once the EventSource handshake completes — which takes longer than a
// plain mount + fetch. Keep this set in sync with the SseIndicator consumers
// (see frontend/src/components/SseIndicator.tsx); a stale name here just means a
// route silently reverts to the short wait.
const SSE_ROUTES = new Set(['agents', 'workflows']);

// Post-mount settle waits (ms). Verified 2026-05-25: a 5000ms wait lands the
// SseIndicator on 'live' in both themes for /agents and /workflows, whereas the
// old fixed 900ms screenshotted them stuck in 'connecting' (amber). Non-SSE
// routes keep the short wait so the common case isn't slowed.
const DEFAULT_WAIT_MS = 900;
const SSE_WAIT_MS = 5_000;

// Escape hatch: SNAP_WAIT_MS overrides the wait for ALL routes (manual control).
// Unset = auto-detect per route via SSE_ROUTES.
const overrideWaitMs = env.SNAP_WAIT_MS ? Number(env.SNAP_WAIT_MS) : null;
if (overrideWaitMs !== null && !Number.isFinite(overrideWaitMs)) {
  console.error(`SNAP_WAIT_MS must be a number, got "${env.SNAP_WAIT_MS}"`);
  exit(1);
}

const waitFor = (r) =>
  overrideWaitMs ?? (SSE_ROUTES.has(r) ? SSE_WAIT_MS : DEFAULT_WAIT_MS);

const args = argv.slice(2);
const route = args[0];
const theme = args[1];

const wantRoutes = route ? [route] : ROUTES;
const wantThemes = theme ? [theme] : THEMES;

if (route && !ROUTES.includes(route)) {
  console.error(`Unknown route "${route}". Valid: ${ROUTES.join(', ')}`);
  exit(1);
}
if (theme && !THEMES.includes(theme)) {
  console.error(`Unknown theme "${theme}". Valid: ${THEMES.join(', ')}`);
  exit(1);
}

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
try {
  for (const t of wantThemes) {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: t,
      // Pre-pin the theme in localStorage so the inline FOUC script
      // applies the data-theme attribute before paint.
      storageState: {
        cookies: [],
        origins: [
          {
            origin: BASE,
            localStorage: [{ name: 'gascity:theme', value: t }],
          },
        ],
      },
    });
    const page = await ctx.newPage();
    for (const r of wantRoutes) {
      const url = `${BASE}/${r}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      // Wait for the React app to mount + at least one fetch round trip.
      // Vite dev keeps an HMR socket open so networkidle never fires.
      await page.waitForSelector('header', { timeout: 5_000 }).catch(() => {});
      // SSE routes need extra time for the EventSource to reach 'live'; others
      // keep the short wait. SNAP_WAIT_MS overrides both. See waitFor() above.
      await page.waitForTimeout(waitFor(r));
      const path = `${OUT}/${t}-${r}.png`;
      await page.screenshot({ path, fullPage: false });
      console.log(`snap ${path}`);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
