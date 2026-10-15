#!/usr/bin/env node
// Usage: node measure-image.js <screenshot.png|jpg> [--scale 1] [--max-gap 120]
//                              [--min-gap 1] [--min-size 4] [--tol 6] [--out out] [--all]
//
// Same output as measure.js, but from a screenshot instead of a live page.
// Elements are detected from the pixels, so it is less exact than measure.js:
// text is measured on the visible letters, not on the line-height box.
//
// --scale: screenshot pixels per CSS pixel. 1 for a normal screen, 2 for a
// retina / 200% screen, 1.25 for Windows 125%, etc.

import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { drawHighlights, drawGaps } from './browser.js';
import { detectRegions } from './image.js';
import { findGaps, groupGaps } from './measure.js';

const HIGHLIGHT = '#00c853';
const GAP_COLOR = '#ff1744';
const INNER_GAP_COLOR = '#2962ff';
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

function parseArgs(argv) {
  const opts = { scale: 1, maxGap: 120, minGap: 1, minSize: 4, tol: 6, out: 'out', all: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--scale') opts.scale = Number(next());
    else if (a === '--max-gap') opts.maxGap = Number(next());
    else if (a === '--min-gap') opts.minGap = Number(next());
    else if (a === '--min-size') opts.minSize = Number(next());
    else if (a === '--tol') opts.tol = Number(next());
    else if (a === '--out') opts.out = next();
    else if (a === '--all') opts.all = true;
    else rest.push(a);
  }
  opts.image = rest[0];
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const mime = opts.image && MIME[path.extname(opts.image).toLowerCase()];
  if (!opts.image || !mime) {
    console.error('Usage: node measure-image.js <screenshot.png|jpg|webp> [--scale 1] [--max-gap 120] [--min-gap 1] [--min-size 4] [--tol 6] [--out out] [--all]');
    process.exit(1);
  }

  const data = await readFile(opts.image);
  const browser = await chromium.launch();
  try {
    // The page shows the screenshot at CSS size (image px / scale) with
    // deviceScaleFactor = scale, so the output keeps the original resolution
    // and the overlay works in CSS pixels.
    const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: opts.scale });
    await page.setContent(
      `<body style="margin:0"><img id="shot" style="display:block" src="data:${mime};base64,${data.toString('base64')}"></body>`,
    );
    const { w, h } = await page.evaluate(async () => {
      const img = document.getElementById('shot');
      await img.decode();
      return { w: img.naturalWidth, h: img.naturalHeight };
    });
    const cssWidth = Math.round(w / opts.scale);
    await page.evaluate((cw) => { document.getElementById('shot').style.width = `${cw}px`; }, cssWidth);
    await page.setViewportSize({ width: cssWidth, height: Math.min(Math.round(h / opts.scale), 4000) });
    console.log(`Image ${w}x${h}px, scale ${opts.scale} -> ${cssWidth}px CSS wide.`);

    const boxes = await page.evaluate(detectRegions, {
      scale: opts.scale,
      tol: opts.tol,
      joinX: Math.round(6 * opts.scale),
      joinY: Math.round(2 * opts.scale),
      minSize: opts.minSize,
    });
    const allGaps = findGaps(boxes, opts.maxGap).filter((g) => g.px >= opts.minGap);
    const gaps = opts.all ? allGaps.map((g) => ({ ...g, count: 1 })) : groupGaps(allGaps, boxes);
    console.log(`Found ${boxes.length} elements and ${allGaps.length} gaps (${opts.minGap}-${opts.maxGap}px), ` +
      `${gaps.length} after grouping repeated ones.`);

    await mkdir(opts.out, { recursive: true });
    const highlighted = path.join(opts.out, 'highlighted.png');
    const annotated = path.join(opts.out, 'annotated.png');

    await page.evaluate(drawHighlights, { boxes, color: HIGHLIGHT });
    await page.screenshot({ path: highlighted, fullPage: true });
    const drawn = await page.evaluate(drawGaps, { gaps, colors: { sibling: GAP_COLOR, inner: INNER_GAP_COLOR } });
    if (drawn < gaps.length) console.log(`${gaps.length - drawn} gaps skipped: no free space for their label.`);
    await page.screenshot({ path: annotated, fullPage: true });

    console.log(`Saved:\n  ${highlighted}\n  ${annotated}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
