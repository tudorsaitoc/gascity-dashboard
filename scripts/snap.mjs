// Headless screenshot harness for design iteration.
//
// Usage:
//   node scripts/snap.mjs            # snap all routes × both themes
//   node scripts/snap.mjs agents     # snap one route, both themes
//   node scripts/snap.mjs agents light  # one route, one theme
//
// Output: /tmp/cp-snaps/<theme>-<route>.png at 1440×900 (MBP-ish).

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { argv, exit } from 'node:process';

const BASE = 'http://127.0.0.1:5174';
const OUT  = '/tmp/cp-snaps';

const ROUTES = ['agents', 'beads', 'workflows', 'mail', 'activity', 'health', 'maintainer'];
const THEMES = ['light', 'dark'];

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
      await page.waitForTimeout(900);
      const path = `${OUT}/${t}-${r}.png`;
      await page.screenshot({ path, fullPage: false });
      console.log(`snap ${path}`);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
