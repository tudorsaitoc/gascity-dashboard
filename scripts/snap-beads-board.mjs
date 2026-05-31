// One-off: screenshot the live Beads Board view (gascity-dashboard-6frc).
// Drives whatever vite is serving on :5174 against the live backend — no
// mocking. Captures the board, then a bead selected (detail rail + dep tree).
//
//   node scripts/snap-beads-board.mjs [light|dark]

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.env.SNAP_BASE || 'http://127.0.0.1:5174';
const CITY = process.env.SNAP_CITY || 'ds-research';
const THEME = process.argv[2] === 'dark' ? 'dark' : 'light';
const OUT = '/tmp/cp-snaps';

const url = `${BASE}/city/${CITY}/beads`;

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const apiErrors = [];
page.on('response', (r) => {
  if (r.url().includes('/api/') && r.status() >= 400) {
    apiErrors.push(`${r.status()} ${r.url()}`);
  }
});
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE.ERR:', m.text());
});

console.log(`navigating ${url} (${THEME})`);
await page.goto(url, { waitUntil: 'domcontentloaded' });

// Apply theme by toggling the documentElement class the app uses.
if (THEME === 'dark') {
  await page.evaluate(() => document.documentElement.classList.add('dark'));
}

// Give the board a chance to render; always snap, even if the region wait
// times out, so we can see what actually came up.
try {
  await page
    .getByRole('region', { name: 'in progress' })
    .waitFor({ timeout: 12_000 });
  console.log('board columns rendered.');
} catch {
  console.log('board region not found in time — snapping whatever rendered.');
  const heading = await page.locator('h1, h2').first().textContent().catch(() => null);
  console.log('top heading:', heading);
}
await page.screenshot({ path: `${OUT}/${THEME}-beads-board.png`, fullPage: true });
console.log(`wrote ${OUT}/${THEME}-beads-board.png`);

// Select the first bead in any column to show the detail rail + dep tree.
const firstBead = page.locator('button[title^="Select "]').first();
if (await firstBead.count()) {
  await firstBead.click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/${THEME}-beads-board-selected.png` });
  console.log(`wrote ${OUT}/${THEME}-beads-board-selected.png`);
}

await browser.close();
if (apiErrors.length) {
  console.log(`\n${apiErrors.length} /api error(s):`);
  for (const e of apiErrors.slice(0, 10)) console.log('  ' + e);
} else {
  console.log('\nno /api errors during the journey.');
}
