// One-shot computed-style probe. Pass a route as the first arg.
import { chromium } from 'playwright';

const route = process.argv[2] ?? 'agents';
const theme = process.argv[3] ?? 'light';

const browser = await chromium.launch();
const ctx = await browser.newContext({
  colorScheme: theme,
  storageState: {
    cookies: [],
    origins: [
      { origin: 'http://127.0.0.1:5174', localStorage: [{ name: 'gascity:theme', value: theme }] },
    ],
  },
});
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:5174/${route}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

const info = await page.evaluate(() => {
  const collect = (sel) =>
    [...document.querySelectorAll(sel)].slice(0, 6).map((el) => ({
      tag: el.tagName,
      cls: el.className,
      text: (el.innerText ?? '').slice(0, 60),
      color: getComputedStyle(el).color,
      bg: getComputedStyle(el).backgroundColor,
      font: getComputedStyle(el).fontFamily,
      weight: getComputedStyle(el).fontWeight,
      size: getComputedStyle(el).fontSize,
    }));
  return {
    body: {
      color: getComputedStyle(document.body).color,
      bg: getComputedStyle(document.body).backgroundColor,
      font: getComputedStyle(document.body).fontFamily,
    },
    headings: collect('h1, h2'),
    panels: collect('.panel'),
    bigText: collect('[class*="text-lg"], [class*="font-semibold"]'),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
