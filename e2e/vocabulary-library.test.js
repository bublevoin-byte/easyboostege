import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));

async function availablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Continue through the standard Windows browser locations.
    }
  }
  throw new Error('Chrome/Chromium executable was not found. Set CHROME_PATH.');
}

async function waitForReady(baseUrl, child, output) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Server exited early.\n' + output.join(''));
    try {
      if ((await fetch(baseUrl + '/health/ready')).ok) return;
    } catch {
      // The connection is expected to fail while the child starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Server did not become ready.\n' + output.join(''));
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

let browser;
let child;
let temporaryDirectory;
try {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-vocabulary-'));
  const port = await availablePort();
  const baseUrl = 'http://127.0.0.1:' + port;
  const dataFile = path.join(temporaryDirectory, 'data.json');
  await fs.writeFile(dataFile, '{}', 'utf8');
  const output = [];
  child = spawn(process.execPath, [serverPath], {
    cwd: projectDirectory,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      APP_URL: baseUrl,
      DATABASE_PROVIDER: 'file',
      DATA_FILE: dataFile,
      JWT_SECRET: 'vocabulary-e2e-test-only-secret-32-characters',
      TELEGRAM_BOT_TOKEN: '',
      ADMIN_TELEGRAM_ID: '',
      XAI_ENABLED: 'false',
      VOICE_TUTOR_ENABLED: 'false',
      ADAPTIVE_LEARNING_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  await waitForReady(baseUrl, child, output);

  browser = await chromium.launch({ headless: true, executablePath: await chromeExecutable() });
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Попробовать демо' }).click();
  await page.getByRole('button', { name: 'Слова', exact: true }).press('Enter');
  await page.locator('#scr2.on').waitFor();
  await page.getByRole('heading', { name: 'Сегодня' }).waitFor();

  const summary = page.getByLabel('План на сегодня');
  assert.match(await summary.innerText(), /к сроку/u);
  assert.match(await summary.innerText(), /новых/u);
  assert.match(await summary.innerText(), /минут/u);
  assert.equal(await page.locator('#w_budget_10').getAttribute('aria-pressed'), 'true');
  await page.locator('#w_budget_20').press('Enter');
  assert.equal(await page.locator('#w_budget_20').getAttribute('aria-pressed'), 'true');

  await page.getByRole('button', { name: /^Начать ·/u }).press('Enter');
  await page.locator('#w_card').waitFor();
  assert.equal(await page.locator('#w_card').evaluate((card) => getComputedStyle(card).animationName), 'none');
  await page.evaluate(() => window.wShowHome());
  await page.getByRole('heading', { name: 'Сегодня' }).waitFor();

  const loading = await page.evaluate(() => {
    window.initWords();
    return document.querySelector('#w_area [role="status"]')?.textContent || '';
  });
  assert.match(loading, /Готовим словарь/u);
  await page.getByRole('heading', { name: 'Сегодня' }).waitFor();

  await page.evaluate(() => {
    window.EGE_WORDS.push({
      w: 'learner note', p: 'n', t: 0, tr: 'личная заметка', ex: '',
      provenance: 'personal',
    });
    window.EGE_WORDS.push({
      w: 'generated sample', p: 'n', t: 0, tr: 'созданный пример', ex: '',
      provenance: 'generated',
    });
    window.S.srs['learner note'] = { s: 1, e: 0, n: 1, due: Date.now() };
    window.S.srs['generated sample'] = { s: 1, e: 0, n: 1, due: Date.now() };
    window.S.srs['To Orphan Started'] = { s: 1, e: 0, n: 1, due: Date.now() };
    window.S.wstatus['known only'] = 'know';
  });
  await page.getByRole('button', { name: 'Открыть библиотеку слов' }).press('Enter');
  await page.getByRole('heading', { name: 'Библиотека' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'w_library_title');
  assert.equal(await page.locator('.vocab-source-personal').count(), 2);
  assert.equal(await page.locator('.vocab-source-generated').count(), 1);
  assert.equal(await page.locator('.vocab-source-unknown').filter({ hasText: 'To Orphan Started' }).count(), 1);
  assert.match(await page.locator('.vocab-source-personal').filter({ hasText: 'known only' }).innerText(), /Изучаю/u);

  await page.getByText('Фильтры', { exact: true }).click();
  for (const label of ['Образование', 'Наука и технологии', 'Новое', 'Проверенная база']) {
    await page.getByLabel(label).focus();
    await page.keyboard.press('Space');
  }
  const search = page.getByRole('searchbox', { name: 'Поиск по слову или переводу' });
  await search.fill('achievement');
  await page.getByText('Найдено слов: 1').waitFor();
  const achievementRow = page.locator('.vocab-word-open').filter({ hasText: 'achievement' });
  assert.equal(await achievementRow.count(), 1);

  const masteryBefore = await page.evaluate(() => JSON.stringify(window.S.srs));
  await achievementRow.press('Enter');
  await page.getByRole('heading', { name: 'achievement' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'w_detail_title');
  assert.equal(await page.getByText('Транскрипция пока не добавлена').count(), 1);
  assert.equal(await page.getByText('Уровень пока не указан').count(), 1);
  assert.equal(await page.getByText('Источник пока не указан').count(), 1);
  const translation = page.getByText('Перевод примера пока не добавлен');
  assert.equal(await translation.isHidden(), true);
  await page.getByRole('button', { name: 'Показать перевод' }).press('Enter');
  assert.equal(await translation.isVisible(), true);
  await page.getByRole('button', { name: 'Озвучить пример 1' }).press('Enter');
  await page.getByRole('button', { name: 'Озвучить слово achievement' }).press('Enter');
  assert.equal(await page.evaluate(() => JSON.stringify(window.S.srs)), masteryBefore);
  assert.equal(await page.evaluate(() => {
    const area = document.getElementById('w_area');
    return area.scrollWidth <= area.clientWidth;
  }), true);

  await page.keyboard.press('Escape');
  await page.getByRole('heading', { name: 'Библиотека' }).waitFor();
  await page.waitForFunction(() => document.activeElement?.dataset?.vocabWord === 'achievement');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.vocabWord), 'achievement');
  assert.equal(await search.inputValue(), 'achievement');
  assert.equal(await page.getByLabel('Образование').isChecked(), true);
  assert.equal(await page.getByLabel('Наука и технологии').isChecked(), true);
  assert.equal(await page.getByLabel('Новое').isChecked(), true);
  assert.equal(await page.getByLabel('Проверенная база').isChecked(), true);
  assert.equal(await page.locator('#w_library_status').getAttribute('aria-live'), 'polite');

  const layout = await page.evaluate(() => {
    const area = document.getElementById('w_area');
    return {
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      fits: area.scrollWidth <= area.clientWidth,
    };
  });
  assert.equal(layout.reduced, true);
  assert.equal(layout.fits, true);

  await search.fill('no-such-vocabulary-item');
  await page.locator('#w_library_results').getByText('Пока пусто').waitFor();
  await page.evaluate(() => window.wShowWord(encodeURIComponent('missing detail')));
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /Карточка не найдена/u);

  assert.deepEqual(pageErrors, []);

  await context.close();
  console.log('vocabulary library e2e passed');
} finally {
  if (browser) await browser.close();
  await stopProcess(child);
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
