#!/usr/bin/env node
// Usage: measure <url> [--width 1440] [--height 900] [--max-gap 120]
//                              [--min-gap 1] [--min-size 4] [--scope "<css selector>"]
//                              [--out out] [--all] [--session session.json]
//                              [--wait <ms>] [--wait-for "<css selector>"]
//
// 1. opens the page at deviceScaleFactor 1 (1 screenshot px = 1 CSS px)
// 2. highlights the visible elements and takes a full-page screenshot
// 3. measures the gaps to the nearest neighbour above/below/left/right
// 4. draws the gaps and saves an annotated screenshot
// 5. labels every text with its rendered font and size (fonts.png)

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { collectBoxes, drawHighlights, drawGaps, drawFonts } from './browser.js';

const HIGHLIGHT = '#00c853';
const GAP_COLOR = '#ff1744';
const INNER_GAP_COLOR = '#2962ff';
const FONT_COLOR = '#6a1b9a';
const FALLBACK_FONT_COLOR = '#ef6c00';
const COOKIE_BUTTONS = /^(accept(ă|a)?( all| toate| tot)?|accept all cookies|permite toate|permite tot|sunt de acord|de acord|allow all|ok|got it)$/i;

function parseArgs(argv) {
  const opts = { width: 1440, height: 900, maxGap: 120, minGap: 1, minSize: 4, scope: null, out: 'out', all: false,
    session: null, wait: 0, waitFor: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--width') opts.width = Number(next());
    else if (a === '--height') opts.height = Number(next());
    else if (a === '--max-gap') opts.maxGap = Number(next());
    else if (a === '--min-size') opts.minSize = Number(next());
    else if (a === '--min-gap') opts.minGap = Number(next());
    else if (a === '--all') opts.all = true;
    else if (a === '--session') opts.session = next();
    else if (a === '--wait') opts.wait = Number(next());
    else if (a === '--wait-for') opts.waitFor = next();
    else if (a === '--scope') opts.scope = next();
    else if (a === '--out') opts.out = next();
    else rest.push(a);
  }
  opts.url = rest[0];
  return opts;
}

// Direct neighbours, like Figma's Alt-hover:
// - every box gets a container: the smallest box that fully contains it
//   (or the page itself);
// - in each direction (up/down/left/right) the gap goes to the nearest box in
//   the same container that overlaps it on the other axis ("sibling" gap);
// - if there is none, the gap goes to the container's edge ("inner" gap,
//   i.e. padding).
// A->B below and B->A above are the same gap, so each one is reported once.
export function findGaps(boxes, maxGap) {
  const overlap = (a1, a2, b1, b2) => Math.min(a2, b2) - Math.max(a1, b1);
  const contains = (o, i) => o.x <= i.x && o.y <= i.y && o.x + o.w >= i.x + i.w && o.y + o.h >= i.y + i.h;

  const parent = new Map();
  for (const a of boxes) {
    let best = null;
    for (const b of boxes) {
      if (a !== b && contains(b, a) && (!best || b.w * b.h < best.w * best.h)) best = b;
    }
    parent.set(a, best);
  }

  const gaps = new Map();
  const span = (a1, a2, b1, b2) => Math.round((Math.max(a1, b1) + Math.min(a2, b2)) / 2);

  for (const a of boxes) {
    const p = parent.get(a);
    const best = { up: null, down: null, left: null, right: null };
    for (const b of boxes) {
      if (a === b || parent.get(b) !== p) continue;
      const ox = overlap(a.x, a.x + a.w, b.x, b.x + b.w);
      const oy = overlap(a.y, a.y + a.h, b.y, b.y + b.h);
      if (ox > 0 && oy > 0) continue; // overlapping boxes have no gap

      if (ox > 0) {
        const down = b.y - (a.y + a.h);
        const up = a.y - (b.y + b.h);
        if (down >= 0 && (!best.down || down < best.down.px)) best.down = { b, px: down };
        if (up >= 0 && (!best.up || up < best.up.px)) best.up = { b, px: up };
      }
      if (oy > 0) {
        const right = b.x - (a.x + a.w);
        const left = a.x - (b.x + b.w);
        if (right >= 0 && (!best.right || right < best.right.px)) best.right = { b, px: right };
        if (left >= 0 && (!best.left || left < best.left.px)) best.left = { b, px: left };
      }
    }

    for (const [dir, hit] of Object.entries(best)) {
      const axis = dir === 'up' || dir === 'down' ? 'y' : 'x';

      if (hit) {
        if (hit.px > maxGap) continue;
        const [first, second] = dir === 'down' || dir === 'right' ? [a, hit.b] : [hit.b, a];
        const key = `${axis}:${first.id}:${second.id}`;
        if (gaps.has(key)) continue;
        // Line drawn in the middle of the shared span on the other axis.
        const line = axis === 'y'
          ? { from: first.y + first.h, to: second.y, at: span(first.x, first.x + first.w, second.x, second.x + second.w) }
          : { from: first.x + first.w, to: second.x, at: span(first.y, first.y + first.h, second.y, second.y + second.h) };
        gaps.set(key, { kind: 'sibling', axis, px: hit.px, a: first.id, b: second.id, ...line });
        continue;
      }

      // No neighbour in this direction: measure the padding to the container.
      if (!p) continue;
      const line = {
        up: { from: p.y, to: a.y },
        down: { from: a.y + a.h, to: p.y + p.h },
        left: { from: p.x, to: a.x },
        right: { from: a.x + a.w, to: p.x + p.w },
      }[dir];
      const px = line.to - line.from;
      if (px <= 0 || px > maxGap) continue;
      line.at = axis === 'y' ? Math.round(a.x + a.w / 2) : Math.round(a.y + a.h / 2);
      gaps.set(`in:${dir}:${a.id}`, { kind: 'inner', axis, px, a: a.id, b: p.id, ...line });
    }
  }
  return [...gaps.values()];
}

// Repeated components (cards, footer links) produce the same gap many times.
// Gaps with the same kind, direction, size and element types on both ends are
// grouped: only the first one is drawn, labelled with how often it repeats.
// A different size (e.g. 21px among 20px) stays separate, so it stands out.
export function groupGaps(gaps, boxes) {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const groups = new Map();
  for (const g of gaps) {
    const key = [g.kind, g.axis, g.px, byId.get(g.a).sig, byId.get(g.b).sig].join('~');
    const first = groups.get(key);
    if (first) first.count++;
    else groups.set(key, { ...g, count: 1 });
  }
  return [...groups.values()];
}

// CSS font-family is only a wish list; Chrome knows which font it actually
// used (DevTools "Rendered Fonts"). A webfont that failed to load shows up
// here as a fallback (e.g. Arial instead of Montserrat).
async function resolveFonts(page, boxes) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  for (const b of boxes) {
    if (!b.font) continue;
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-sm-id="${b.id}"]` });
    if (!nodeId) continue;
    const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId }).catch(() => ({ fonts: [] }));
    const main = fonts.sort((x, y) => y.glyphCount - x.glyphCount)[0];
    if (main) Object.assign(b.font, { rendered: main.familyName, custom: main.isCustomFont });
  }
  await cdp.detach();
}

// One label per text; repeated components with the same font are drawn
// once, like the gaps.
// The CSS name and the font's own name often differ only in spelling
// ("proxima-nova" vs "Proxima Nova"), so names are compared without case,
// spaces and dashes. A loaded webfont (custom) is never a fallback, since
// font services may register it under any CSS name.
export function fontLabels(boxes, all) {
  const norm = (n) => n.toLowerCase().replace(/[\s_-]+/g, '');
  // CSS name -> real font name, for texts Chrome reported no font for
  // (e.g. inputs).
  const realName = new Map();
  for (const b of boxes) {
    const f = b.font;
    if (f?.rendered && (f.custom || norm(f.rendered) === norm(f.declared))) realName.set(norm(f.declared), f.rendered);
  }

  const items = new Map();
  for (const b of boxes) {
    if (!b.font) continue;
    const { declared, rendered, custom, size, weight } = b.font;
    const fallback = Boolean(rendered) && !custom && norm(rendered) !== norm(declared);
    const family = fallback ? rendered : realName.get(norm(declared)) ?? rendered ?? declared;
    const label = `${family} ${size}px ${weight}` + (fallback ? ` (instead of ${declared})` : '');
    const key = all ? b.id : `${b.sig}~${label}`;
    const first = items.get(key);
    if (first) first.count++;
    else items.set(key, { x: b.x, y: b.y, w: b.w, h: b.h, label, fallback, count: 1 });
  }
  return [...items.values()];
}

async function preparePage(page, { url, wait, waitFor }) {
  await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  if (waitFor) await page.waitForSelector(waitFor, { state: 'visible', timeout: 60_000 });
  if (wait) await page.waitForTimeout(wait);

  // Best-effort cookie banner dismissal.
  const button = page.getByRole('button', { name: COOKIE_BUTTONS }).first();
  if (await button.isVisible().catch(() => false)) {
    await button.click({ timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(500);
  }

  // Scroll through the page so lazy-loaded images load, then back to top.
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.8;
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 150));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

  // Hide what is still covering the page: popups, modals, leftover cookie
  // banners. Fixed headers stay, because they cover only a small strip.
  await page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      const isDialog = el.tagName === 'DIALOG' || el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true';
      if (cs.position !== 'fixed' && !isDialog) continue;
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      const covered = (Math.min(r.right, vw) - Math.max(r.left, 0)) * (Math.min(r.bottom, vh) - Math.max(r.top, 0));
      if (isDialog || covered > vw * vh * 0.25) el.style.setProperty('display', 'none', 'important');
    }
    document.documentElement.style.setProperty('overflow', 'visible', 'important');
    document.body.style.setProperty('overflow', 'visible', 'important');
  });

  // Freeze animations/transitions so nothing moves between measuring and
  // taking the screenshot.
  await page.addStyleTag({
    content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}',
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(300);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.url) {
    console.error('Usage: measure <url> [--width 1440] [--max-gap 120] [--min-gap 1] [--min-size 4] [--scope "<selector>"] [--out out] [--all] [--session session.json] [--wait <ms>] [--wait-for "<selector>"]');
    process.exit(1);
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: opts.width, height: opts.height },
      deviceScaleFactor: 1,
      // Accept local/self-signed certificates (DDEV, mkcert).
      ignoreHTTPSErrors: true,
      // Cookies + localStorage saved by session.js (cart, login...).
      storageState: opts.session ?? undefined,
    });
    console.log(`Loading ${opts.url} at ${opts.width}px${opts.session ? ` with session ${opts.session}` : ''}...`);
    await preparePage(page, opts);

    const boxes = await page.evaluate(collectBoxes, { scope: opts.scope, minSize: opts.minSize });
    await resolveFonts(page, boxes);
    const allGaps = findGaps(boxes, opts.maxGap).filter((g) => g.px >= opts.minGap);
    const gaps = opts.all ? allGaps.map((g) => ({ ...g, count: 1 })) : groupGaps(allGaps, boxes);
    console.log(`Found ${boxes.length} elements and ${allGaps.length} gaps (${opts.minGap}-${opts.maxGap}px), ` +
      `${gaps.length} after grouping repeated ones.`);

    await mkdir(opts.out, { recursive: true });
    const highlighted = path.join(opts.out, 'highlighted.png');
    const annotated = path.join(opts.out, 'annotated.png');
    const fontsPng = path.join(opts.out, 'fonts.png');

    await page.evaluate(drawHighlights, { boxes, color: HIGHLIGHT });
    await page.screenshot({ path: highlighted, fullPage: true });

    const drawn = await page.evaluate(drawGaps, { gaps, colors: { sibling: GAP_COLOR, inner: INNER_GAP_COLOR } });
    if (drawn < gaps.length) console.log(`${gaps.length - drawn} gaps skipped: no free space for their label.`);
    await page.screenshot({ path: annotated, fullPage: true });

    const fontItems = fontLabels(boxes, opts.all);
    const fontsDrawn = await page.evaluate(drawFonts, { items: fontItems, color: FONT_COLOR, warnColor: FALLBACK_FONT_COLOR });
    if (fontsDrawn < fontItems.length) console.log(`${fontItems.length - fontsDrawn} font labels skipped: no free space.`);
    await page.screenshot({ path: fontsPng, fullPage: true });

    // Summary: every font/size/weight combination and how many texts use it.
    const usage = new Map();
    for (const it of fontLabels(boxes, true)) usage.set(it.label, (usage.get(it.label) ?? 0) + 1);
    console.log('Fonts:');
    for (const [label, n] of [...usage].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)} × ${label}`);

    console.log(`Saved:\n  ${highlighted}\n  ${annotated}\n  ${fontsPng}`);
  } finally {
    await browser.close();
  }
}

// realpath so it also runs through the `measure` symlink from npm link
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
