import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import jwt from 'jsonwebtoken';
import { availablePort, chromeExecutable, stopProcess, waitForReady } from './browser-server-harness.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));

let browser;
let child;
let temporaryDirectory;
try {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-vocabulary-'));
  const port = await availablePort();
  const baseUrl = 'http://127.0.0.1:' + port;
  const dataFile = path.join(temporaryDirectory, 'data.json');
  await fs.writeFile(dataFile, JSON.stringify({
    users: {
      'vocabulary-sync-user': {
        created: Date.now(),
        sub_until: Date.now() + 86_400_000,
      },
    },
    progress: { 'vocabulary-sync-user': {} },
  }), 'utf8');
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
  await page.getByRole('button', { name: 'Чтение', exact: true }).press('Enter');
  await page.locator('#scr7.on').waitFor();
  await page.getByRole('button', { name: 'Полное понимание' }).press('Enter');
  const manyInReading = page.locator('#r_area button[data-w="many"]').first();
  await manyInReading.press('Enter');
  await page.locator('#r_tr').getByText(/many|многие/u).waitFor();
  await page.getByRole('button', { name: '+ Учить', exact: true }).press('Enter');
  await manyInReading.press('Enter');
  await page.getByRole('button', { name: '+ Учить', exact: true }).press('Enter');
  await manyInReading.press('Enter');
  await page.locator('#r_pop button[onclick="r_add(\'know\')"]').press('Enter');

  const volunteerInReading = page.locator('#r_area button[data-w="volunteer"]').first();
  await volunteerInReading.press('Enter');
  await page.locator('#r_pop').waitFor();
  await page.locator('#r_pop button[onclick="r_add(\'know\')"]').press('Enter');
  await volunteerInReading.press('Enter');
  await page.locator('#r_pop button[onclick="r_add(\'know\')"]').press('Enter');
  const readingCards = await page.evaluate(() => ({
    cards: window.S.personalWords,
    progress: window.S.srs.volunteer,
  }));
  assert.equal(readingCards.cards.length, 2);
  assert.equal(readingCards.cards.find((card) => card.id === 'personal:many').contexts.length, 1);
  assert.equal(readingCards.cards.find((card) => card.id === 'personal:many').partOfSpeech, null);
  assert.equal(readingCards.cards.find((card) => card.id === 'personal:volunteer').partOfSpeech, 'v');
  assert.equal(readingCards.progress.dimensions.meaning.evidence, 'self_reported');
  assert.equal(readingCards.progress.dimensions.meaning.attempts, 1);
  assert.equal(readingCards.progress.dimensions.meaning.independentSuccesses, 0);
  assert.equal(readingCards.progress.lastMode, 'russian_reveal');
  await page.getByRole('button', { name: 'Главная', exact: true }).last().press('Enter');
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
  assert.equal(await page.locator('.vocab-source-personal').count(), 4);
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

  await page.evaluate(() => window.wClearLibraryFilters());
  await page.getByRole('searchbox', { name: 'Поиск по слову или переводу' }).fill('gap year before university');
  const contextualPersonal = page.locator('.vocab-source-personal').filter({ hasText: 'many' });
  assert.equal(await contextualPersonal.count(), 1);
  await contextualPersonal.locator('.vocab-word-open').press('Enter');
  await page.getByRole('heading', { name: 'many' }).waitFor();
  assert.equal(await page.getByText('Часть речи не указана').count(), 1);
  assert.equal(await page.locator('.vocab-example p[lang="en"]', {
    hasText: 'Many British students take a gap year before university.',
  }).count(), 1);
  assert.equal(await page.getByRole('button', { name: 'Удалить личную карточку' }).count(), 1);
  const progressBeforeManyDelete = await page.evaluate(() => JSON.stringify(window.S.srs.many));
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Удалить личную карточку' }).press('Enter');
  assert.equal(await page.getByRole('heading', { name: 'many' }).count(), 1);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Удалить личную карточку' }).press('Enter');
  await page.getByRole('heading', { name: 'Библиотека' }).waitFor();
  await page.getByRole('searchbox', { name: 'Поиск по слову или переводу' }).fill('many');
  assert.equal(await page.locator('.vocab-source-personal').filter({ hasText: 'many' }).count(), 0);
  assert.equal(await page.locator('.vocab-source-unknown').filter({ hasText: 'many' }).count(), 1);
  assert.equal(await page.evaluate(() => JSON.stringify(window.S.srs.many)), progressBeforeManyDelete);
  await page.getByRole('searchbox', { name: 'Поиск по слову или переводу' }).fill('volunteer');
  const personalVolunteer = page.locator('.vocab-source-personal').filter({ hasText: 'volunteer' });
  const coreVolunteer = page.locator('.vocab-source-core').filter({ hasText: 'to volunteer' });
  assert.equal(await personalVolunteer.count(), 1);
  assert.equal(await coreVolunteer.count(), 1);
  await personalVolunteer.locator('.vocab-word-open').press('Enter');
  const progressBeforePersonalDelete = await page.evaluate(() => JSON.stringify(window.S.srs.volunteer));
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Удалить личную карточку' }).press('Enter');
  assert.equal(await page.getByRole('heading', { name: 'volunteer' }).count(), 1);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Удалить личную карточку' }).press('Enter');
  await page.getByRole('heading', { name: 'Библиотека' }).waitFor();
  assert.equal(await page.locator('.vocab-source-personal').filter({ hasText: 'volunteer' }).count(), 0);
  assert.equal(await page.locator('.vocab-source-core').filter({ hasText: 'to volunteer' }).count(), 1);
  assert.equal(await page.evaluate(() => JSON.stringify(window.S.srs.volunteer)), progressBeforePersonalDelete);

  await page.evaluate(() => {
    const coreVolunteer = window.EGE_WORDS.find((item) => window.wBase(item.w) === 'volunteer'
      && Number(item.t) >= 1);
    window.EGE_WORDS.splice(0, window.EGE_WORDS.length, coreVolunteer);
    window.S.srs = { volunteer: window.S.srs.volunteer };
    window.S.personalWords = [];
    window.S.wstatus = {};
    window.wShowHome();
  });
  await page.getByRole('button', { name: /^Начать ·/u }).press('Enter');
  await page.getByRole('heading', { name: 'Напиши слово' }).waitFor();
  await page.getByLabel('Ответ по-английски').fill('volunteer');
  await page.getByRole('button', { name: 'Проверить' }).press('Enter');
  assert.equal(await page.evaluate(() => Boolean(window.S.srs['to volunteer'])), false);
  assert.equal(await page.evaluate(() => window.S.srs.volunteer.dimensions.spelling.attempts), 1);
  await page.evaluate(() => window.wShowLibrary());
  await page.getByRole('heading', { name: 'Библиотека' }).waitFor();

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

  await page.evaluate(() => {
    const now = Date.now() - 1_000;
    window.EGE_WORDS.splice(0, window.EGE_WORDS.length,
      { w: 'new word', p: 'n', t: 2, tr: 'новое слово', ex: 'A new word appears.' },
      { w: 'meaning', p: 'n', t: 2, tr: 'смысл', ex: 'The meaning is clear.' },
      { w: 'spelling', p: 'n', t: 2, tr: 'написание', ex: 'Check the spelling.' },
      { w: 'context', p: 'n', t: 2, tr: 'контекст', ex: 'Use context to learn.' },
      { w: 'listening', p: 'n', t: 2, tr: 'аудирование', ex: 'Listening takes practice.' });
    const dimension = (score = 0, evidence = 'none', attempts = 0) => ({
      score, attempts, independentSuccesses: evidence === 'objective' ? attempts : 0,
      evidence, lastPracticedAt: attempts ? now : null,
    });
    const records = {
      meaning: {
        stage: 1, lastMode: 'receptive_meaning', lastOutcome: 'correct',
        dimensions: {
          meaning: dimension(20, 'guided', 1), spelling: dimension(), context: dimension(), listening: dimension(),
        },
      },
      spelling: {
        stage: 2, lastMode: 'russian_reveal', lastOutcome: 'knew',
        dimensions: {
          meaning: dimension(30, 'self_reported', 2), spelling: dimension(), context: dimension(), listening: dimension(),
        },
      },
      context: {
        stage: 3, lastMode: 'english_production', lastOutcome: 'correct',
        dimensions: {
          meaning: dimension(30, 'self_reported', 2), spelling: dimension(35, 'objective', 1),
          context: dimension(), listening: dimension(),
        },
      },
      listening: {
        stage: 4, lastMode: 'contextual_production', lastOutcome: 'correct',
        dimensions: {
          meaning: dimension(30, 'self_reported', 2), spelling: dimension(35, 'objective', 1),
          context: dimension(35, 'objective', 1), listening: dimension(),
        },
      },
    };
    window.S.srs = Object.fromEntries(Object.entries(records).map(([word, record], index) => [word, {
      ...record, word, masteryVersion: 1, s: record.stage, errorCount: 0, e: 0,
      reviewCount: record.stage, n: record.stage, dueAt: now + index, due: now + index,
    }]));
    window.S.personalWords = [{
      cardVersion: 1, id: 'personal:meaning', canonicalWord: 'meaning', word: 'meaning',
      provenance: 'personal', meanings: ['скрытое личное значение'], pronunciation: null,
      partOfSpeech: null, level: null,
      contexts: [{ text: 'A deleted personal context.', source: 'reading' }],
      createdAt: now, updatedAt: now,
    }];
    window.S.personalWordTombstones = ['personal:meaning'];
    window.S.wstatus = {};
    window.S.vocabularyNewBudget = 10;
    window.S.vocabularyHistory = [];
    window.wShowHome();
  });
  await context.setOffline(true);
  await page.getByRole('button', { name: /^Начать ·/u }).press('Enter');

  await page.getByRole('heading', { name: 'Вспомни значение' }).waitFor();
  await page.getByLabel('Твой вариант значения по-русски').fill('значение');
  await page.getByRole('button', { name: 'Показать ответ' }).press('Enter');
  await page.getByText('смысл', { exact: true }).waitFor();
  assert.equal(await page.getByRole('status', { name: 'смысл' }).getAttribute('aria-live'), 'polite');
  await page.waitForFunction(() => document.activeElement?.id === 'w_session_title');
  await page.getByRole('button', { name: 'Знал(а)', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Дальше' }).press('Enter');

  await page.getByRole('heading', { name: 'Напиши слово' }).waitFor();
  await page.getByLabel('Ответ по-английски').fill('speling');
  await page.getByRole('button', { name: 'Проверить' }).press('Enter');
  await page.getByText('Почти — небольшая опечатка').waitFor();
  await page.getByText('spelling', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Озвучить слово spelling' }).count(), 1);
  await page.getByRole('button', { name: 'Дальше' }).press('Enter');

  await page.getByRole('heading', { name: 'Заполни пропуск' }).waitFor();
  await page.getByLabel('Ответ по-английски').fill('context');
  await page.getByRole('button', { name: 'Проверить' }).press('Enter');
  await page.getByRole('button', { name: 'Дальше' }).press('Enter');
  await page.getByRole('heading', { name: 'Напиши на слух' }).waitFor();
  await page.getByRole('button', { name: 'Прослушать ещё раз' }).press('Enter');
  await page.getByLabel('Ответ по-английски').fill('listening');
  await page.getByRole('button', { name: 'Проверить' }).press('Enter');
  await page.getByRole('button', { name: 'Дальше' }).press('Enter');

  await page.getByRole('heading', { name: 'Напиши слово' }).waitFor();
  await page.getByLabel('Ответ по-английски').fill('spelling');
  await page.getByRole('button', { name: 'Проверить' }).press('Enter');
  await page.getByRole('button', { name: 'Дальше' }).press('Enter');
  await page.getByRole('heading', { name: 'Познакомься со словом' }).waitFor();
  await page.getByRole('button', { name: 'Начать вспоминать' }).press('Enter');
  await page.getByRole('heading', { name: 'Выбери значение' }).waitFor();
  await page.waitForFunction(() => document.activeElement?.id === 'w_session_title');
  await page.getByRole('button', { name: 'Не знаю' }).press('Enter');
  await page.getByRole('button', { name: 'Дальше' }).press('Enter');

  await page.getByRole('heading', { name: 'Короткая пауза' }).waitFor({ timeout: 5_000 });
  await page.waitForFunction(() => document.activeElement?.id === 'w_session_title');
  await page.getByRole('button', { name: 'Продолжить' }).press('Enter');
  await page.getByRole('heading', { name: 'Короткая пауза' }).waitFor();
  await page.waitForFunction(() => document.activeElement?.id === 'w_session_title');
  await page.getByRole('button', { name: 'Продолжить' }).press('Enter');
  await page.getByRole('heading', { name: 'Выбери значение' }).waitFor();
  // The task view focuses its heading on the next animation frame. Wait for that
  // accessibility transition before pressing Enter so it cannot steal focus
  // between the answer button's keydown and keyup in a slower CI browser.
  await page.waitForFunction(() => document.activeElement?.id === 'w_session_title');
  await page.getByRole('button', { name: 'новое слово' }).press('Enter');
  await page.getByRole('button', { name: 'Дальше' }).press('Enter');

  await page.getByRole('heading', { name: 'Итоги тренировки' }).waitFor();
  const sessionSummary = page.getByLabel('Итоги сессии');
  assert.match(await sessionSummary.innerText(), /5\s+слов/u);
  assert.match(await sessionSummary.innerText(), /7\s+попыток/u);
  assert.match(await sessionSummary.innerText(), /1\s+знакомство/u);
  assert.match(await sessionSummary.innerText(), /4\s+повторено/u);
  assert.match(await sessionSummary.innerText(), /3\s+самостоятельно/u);
  assert.match(await sessionSummary.innerText(), /2\s+с подсказкой/u);
  assert.match(await sessionSummary.innerText(), /2\s+ошибки/u);
  assert.match(await page.getByLabel('Сложные слова').innerText(), /spelling/u);
  assert.match(await page.getByLabel('Сложные слова').innerText(), /new word/u);
  assert.equal(await page.getByRole('button', { name: 'Потренировать сложные слова' }).count(), 1);
  assert.equal(await page.evaluate(() => Array.isArray(window.S.vocabularyHistory)
    && window.S.vocabularyHistory.length === 1), true);
  assert.equal(await page.evaluate(() => {
    const area = document.getElementById('w_area');
    return matchMedia('(prefers-reduced-motion: reduce)').matches
      && area.scrollWidth <= area.clientWidth;
  }), true);
  await context.setOffline(false);

  await page.getByRole('button', { name: 'К плану на сегодня' }).press('Enter');
  await page.getByRole('heading', { name: 'Сегодня' }).waitFor();
  const trend = page.getByRole('region', { name: 'Самостоятельное вспоминание' });
  assert.match(await trend.innerText(), /7 дней/u);
  assert.match(await trend.innerText(), /30 дней/u);
  assert.match(await page.getByText(/Нужно ещё 3 дня/u).innerText(), /тренд/u);

  assert.deepEqual(pageErrors, []);

  await context.close();

  const authenticatedContext = await browser.newContext({
    viewport: { width: 375, height: 812 },
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  await authenticatedContext.addCookies([{
    name: 'eb_token',
    value: jwt.sign({ u: 'vocabulary-sync-user' }, 'vocabulary-e2e-test-only-secret-32-characters', {
      expiresIn: '1h',
    }),
    url: baseUrl,
    httpOnly: true,
    sameSite: 'Lax',
  }]);
  const authenticatedPage = await authenticatedContext.newPage();
  await authenticatedPage.goto(baseUrl, { waitUntil: 'networkidle' });
  await authenticatedPage.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
  await authenticatedPage.getByRole('button', { name: 'Слова', exact: true }).press('Enter');
  await authenticatedPage.locator('#scr2.on').waitFor();
  await authenticatedPage.evaluate(() => {
    const now = Date.now() - 1_000;
    const dimension = (score = 0, evidence = 'none', attempts = 0) => ({
      score, attempts, independentSuccesses: evidence === 'objective' ? attempts : 0,
      evidence, lastPracticedAt: attempts ? now : null,
    });
    window.EGE_WORDS.splice(0, window.EGE_WORDS.length, {
      w: 'syncword', p: 'n', t: 2, tr: 'слово для синхронизации', ex: 'Type the syncword now.',
    });
    window.S.srs = {
      syncword: {
        word: 'syncword', masteryVersion: 1, stage: 2, s: 2, errorCount: 0, e: 0,
        reviewCount: 2, n: 2, dueAt: now, due: now,
        lastMode: 'russian_reveal', lastOutcome: 'knew',
        dimensions: {
          meaning: dimension(30, 'self_reported', 2), spelling: dimension(),
          context: dimension(), listening: dimension(),
        },
      },
    };
    window.S.personalWords = [];
    window.S.personalWordTombstones = [];
    window.S.wstatus = {};
    window.S.vocabularyHistory = [];
    window.S.vocabularyNewBudget = 5;
    window.wShowHome();
  });
  await authenticatedContext.setOffline(true);
  await authenticatedPage.getByRole('button', { name: /^Начать ·/u }).press('Enter');
  await authenticatedPage.getByRole('heading', { name: 'Напиши слово' }).waitFor();
  await authenticatedPage.getByLabel('Ответ по-английски').fill('syncword');
  await authenticatedPage.getByRole('button', { name: 'Проверить' }).press('Enter');
  await authenticatedPage.getByRole('button', { name: 'Дальше' }).press('Enter');
  await authenticatedPage.getByRole('heading', { name: 'Итоги тренировки' }).waitFor();
  const queuedAttempt = await authenticatedPage.evaluate(() => {
    const attempts = window.EasyBoostSync.pendingModuleAttempts();
    return { count: attempts.length, id: attempts[0]?.id || '', pending: window.EasyBoostSync.hasPending() };
  });
  assert.equal(queuedAttempt.count, 1);
  assert.equal(queuedAttempt.pending, true);
  assert.match(queuedAttempt.id, /^[0-9a-f-]{36}$/u);

  await authenticatedContext.setOffline(false);
  await authenticatedPage.waitForFunction(() => window.EasyBoostSync.pendingModuleAttempts().length === 0);
  await authenticatedPage.evaluate(() => window.EasyBoostSync.flush());
  const persistedAttempts = await fs.readFile(dataFile, 'utf8').then((contents) => {
    const data = JSON.parse(contents);
    return (data.module_attempts || []).filter((attempt) => (
      attempt.username === 'vocabulary-sync-user' && attempt.id === queuedAttempt.id
    ));
  });
  assert.equal(persistedAttempts.length, 1, 'offline completion must synchronize exactly once');
  assert.equal(persistedAttempts[0].evidence_quality, 'client_reported');
  assert.equal(persistedAttempts[0].module, 'vocabulary');
  assert.equal(await authenticatedPage.evaluate(() => window.EasyBoostSync.hasPending()), false);
  await authenticatedContext.close();
  console.log('vocabulary library e2e passed');
} finally {
  if (browser) await browser.close();
  await stopProcess(child);
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
