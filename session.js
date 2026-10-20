#!/usr/bin/env node
// Usage: node session.js <url> [--out session.json]
//
// Opens a visible browser so you can prepare the state a page needs (add
// products to the cart, log in, accept cookies). Press Enter in the terminal
// to save cookies + localStorage, then measure with:
//   node measure.js <url> --session session.json

import { chromium } from 'playwright';
import readline from 'node:readline/promises';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = outIndex >= 0 ? args[outIndex + 1] : 'session.json';
const url = args.find((a, i) => !a.startsWith('--') && i !== outIndex + 1);

if (!url) {
  console.error('Usage: node session.js <url> [--out session.json]');
  process.exit(1);
}

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ viewport: null, ignoreHTTPSErrors: true });
const page = await context.newPage();
await page.goto(url);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await rl.question('Prepare the page in the browser (cart, login...), then press Enter here to save the session. ');
rl.close();

await context.storageState({ path: out });
await browser.close();
console.log(`Session saved to ${out}`);
