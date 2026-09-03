import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { chromeExecutable } from '../e2e/browser-server-harness.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const publicDirectory = path.join(projectDirectory, 'public');
const source = await fs.readFile(path.join(publicDirectory, 'pwa-icon.svg'), 'utf8');
const variants = [
  { name: 'icon-192.png', size: 192, svg: source },
  { name: 'icon-512.png', size: 512, svg: source },
  { name: 'icon-maskable-512.png', size: 512, svg: source.replace('rx="112"', 'rx="0"') },
];

const browser = await chromium.launch({ headless: true, executablePath: await chromeExecutable() });
try {
  for (const variant of variants) {
    const page = await browser.newPage({
      viewport: { width: variant.size, height: variant.size },
      deviceScaleFactor: 1,
    });
    const encoded = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(variant.svg)}`;
    await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:transparent}img{display:block;width:100%;height:100%}</style><img alt="" src="${encoded}">`);
    const image = page.locator('img');
    await image.evaluate((element) => element.decode());
    await image.screenshot({
      path: path.join(publicDirectory, variant.name),
      omitBackground: true,
    });
    await page.close();
  }
} finally {
  await browser.close();
}

console.log('Paper A PWA icons rendered: 192, 512 and maskable 512.');
