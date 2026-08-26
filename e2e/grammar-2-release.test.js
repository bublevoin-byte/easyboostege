import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { GRAMMAR_CATALOG } from '../public/grammar-catalog.js';
import {
  availablePort, chromeExecutable, createActiveSubscriptionPage, openPracticeSkill, stopProcess, waitForReady,
} from './browser-server-harness.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const username = 'grammar-2-release-user';
const jwtSecret = 'grammar-2-release-e2e-secret-32-characters';

async function grammarGeometry(page, label) {
  const geometry = await page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width, height: box.height };
    };
    const action = document.querySelector('#g_primary_action');
    const actionStyle = action ? getComputedStyle(action) : null;
    const affordanceStyle = action ? getComputedStyle(action, '::after') : null;
    return {
      frame: rect('#frame'), screen: rect('#scr3.on'), area: rect('#g_area'), dock: rect('#g_action_dock'),
      action: rect('#g_primary_action'), question: rect('#g_card'), option: rect('#g_btns [role="radio"]'),
      documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth,
      viewportHeight: innerHeight, dynamicViewportHeight: document.documentElement.clientHeight,
      actionRadius: actionStyle?.borderRadius || '', affordanceWidth: affordanceStyle?.width || '',
      affordanceHeight: affordanceStyle?.height || '',
    };
  });
  assert.ok(geometry.frame && geometry.frame.width <= 390.5, `${label}: learner frame stays within 390px`);
  assert.ok(geometry.screen && geometry.area && geometry.area.height > 0, `${label}: Grammar scroll row has positive height`);
  assert.ok(geometry.dock && geometry.dock.bottom <= geometry.frame.bottom + 1,
    `${label}: action dock stays inside phone frame: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.area.bottom <= geometry.dock.top + 1,
    `${label}: scroll row and action dock do not overlap: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.action && Math.abs(geometry.action.height - 58) <= 0.5, `${label}: primary action is exactly 58px high`);
  assert.equal(geometry.actionRadius, '28px', `${label}: primary action keeps its 28px radius`);
  assert.equal(geometry.affordanceWidth, '38px', `${label}: primary action affordance is 38px wide`);
  assert.equal(geometry.affordanceHeight, '38px', `${label}: primary action affordance is 38px high`);
  assert.ok(geometry.documentWidth <= geometry.viewportWidth, `${label}: no horizontal document overflow`);
  if (geometry.question && geometry.option) {
    assert.ok(geometry.question.bottom <= geometry.option.top + 1, `${label}: question and choices do not overlap`);
  }
  return geometry;
}

let browser;
let child;
let context;
let temporaryDirectory;

try {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-grammar-2-release-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataFile = path.join(temporaryDirectory, 'data.json');
  await fs.writeFile(dataFile, JSON.stringify({
    users: {
      [username]: {
        created: Date.now(), sub_until: Date.now() + 86_400_000,
        privacy_consent: {
          text_processing: true, voice_processing: false,
          policy_version: '2026-08-26-vk-id-v1', updated_at: Date.now(),
        },
      },
    },
    progress: { [username]: {} },
  }), 'utf8');
  const output = [];
  child = spawn(process.execPath, [serverPath], {
    cwd: projectDirectory,
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(port), APP_URL: baseUrl,
      DATABASE_PROVIDER: 'file', DATA_FILE: dataFile, JWT_SECRET: jwtSecret,
      TELEGRAM_BOT_TOKEN: '', ADMIN_TELEGRAM_ID: '', XAI_ENABLED: 'false',
      VOICE_TUTOR_ENABLED: 'false', ADAPTIVE_LEARNING_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  await waitForReady(baseUrl, child, output);

  browser = await chromium.launch({ headless: true, executablePath: await chromeExecutable() });
  const harness = await createActiveSubscriptionPage(browser, {
    baseUrl, username, jwtSecret,
    contextOptions: {
      viewport: { width: 375, height: 812 }, reducedMotion: 'reduce', serviceWorkers: 'block',
    },
  });
  context = harness.context;
  const page = harness.page;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
  await openPracticeSkill(page, 'grammar');
  await page.locator('#scr3.on').waitFor({ state: 'visible', timeout: 5_000 });
  await page.locator('[data-grammar-dashboard]').waitFor();
  assert.match(await page.locator('[data-grammar-dashboard]').innerText(), /Grammar 2\.0 · 20 тем/u);
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  assert.equal(await page.locator('#aisy-shell-back:visible').count(), 1, 'deep Grammar has one canonical shell Back');
  assert.equal(await page.locator('#aisy-shell-nav:visible').count(), 0, 'deep Grammar hides global bottom navigation');
  assert.deepEqual(await page.locator('#aisy-shell-nav').evaluate((nav) => ({ hidden: nav.hidden, inert: nav.inert })),
    { hidden: true, inert: true }, 'hidden deep navigation is inert');
  assert.equal(await page.locator('#scr3 .navclay').count(), 0, 'Grammar does not render a local legacy rail');
  assert.equal(await page.locator('#scr3 main[aria-labelledby="g_header_title"] h1').count(), 1);
  assert.equal(await page.getByRole('progressbar', { name: 'Устойчиво освоенные темы' }).count(), 1);

  const themeSurfaces = {};
  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page.evaluate((preference) => window.AisyTheme.set(preference), theme);
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
    await openPracticeSkill(page, 'grammar');
    await page.locator('[data-grammar-dashboard]').waitFor();
    themeSurfaces[theme] = await page.evaluate(() => {
      return {
        preference: document.documentElement.dataset.theme,
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        lightningLight: getComputedStyle(document.documentElement).getPropertyValue('--lightningcss-light'),
        lightningDark: getComputedStyle(document.documentElement).getPropertyValue('--lightningcss-dark'),
        route: getComputedStyle(document.querySelector('.grammar-route')).backgroundColor,
        paper: getComputedStyle(document.querySelector('.grammar-paper')).backgroundColor,
      };
    });
    assert.equal(themeSurfaces[theme].preference, theme);
    assert.notEqual(themeSurfaces[theme].paper, 'rgba(0, 0, 0, 0)', `${theme}: paper sheet is opaque`);
  }
  assert.notEqual(themeSurfaces.light.route, themeSurfaces.dark.route,
    `light and dark modes resolve distinct warm paper canvases: ${JSON.stringify(themeSurfaces)}`);
  assert.notEqual(themeSurfaces.light.paper, themeSurfaces.dark.paper,
    `light and dark modes resolve distinct raised sheets: ${JSON.stringify(themeSurfaces)}`);
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.evaluate(() => window.AisyTheme.set('light'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 5_000 });
  await openPracticeSkill(page, 'grammar');
  await page.locator('[data-grammar-dashboard]').waitFor();

  for (const viewport of [{ width: 320, height: 720 }, { width: 720, height: 320 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await grammarGeometry(page, `dashboard ${viewport.width}×${viewport.height}`);
  }

  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  await page.evaluate(() => window.gStart(1));
  await page.locator('#g_btns [role="radio"]').first().waitFor();
  assert.equal(await page.locator('#g_card').evaluate((card) => getComputedStyle(card).animationName), 'grammar-paper-enter',
    'Direction A uses one right-to-left paper-layer transition');
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  assert.equal(await page.locator('#g_card').evaluate((card) => getComputedStyle(card).animationName), 'grammar-paper-fade',
    'reduced motion replaces the spatial paper shift with opacity only');
  await page.setViewportSize({ width: 320, height: 720 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await grammarGeometry(page, 'choice task 320×720');
  const beforeSelection = await page.evaluate(() => ({
    done: window.S.grammarRunner.done,
    outcomes: window.S.grammarRunner.itemOutcomes.length,
    token: Number((document.querySelector('#g_primary_action')?.getAttribute('onclick')?.match(/\((\d+)\)/u) || [])[1]),
  }));
  assert.equal(Number.isSafeInteger(beforeSelection.token), true, 'the reentrancy check captures the active task token');
  const firstChoice = page.locator('#g_btns [role="radio"]').first();
  await firstChoice.focus();
  await firstChoice.press('ArrowDown');
  assert.equal(await page.locator('#g_btns [role="radio"][aria-checked="true"]').count(), 1,
    'arrow navigation selects exactly one radio');
  assert.match(await page.locator('#g_btns [role="radio"][aria-checked="true"] .grammar-choice__state').innerText(), /Выбрано/u,
    'selection is communicated by text as well as form and color');
  assert.equal(await page.locator('#g_btns [role="radio"][aria-checked="true"]').evaluate((choice) => getComputedStyle(choice).transform), 'none',
    'selected controls do not move under reduced motion');
  assert.deepEqual(await page.evaluate(() => ({
    done: window.S.grammarRunner.done,
    outcomes: window.S.grammarRunner.itemOutcomes.length,
  })), { done: beforeSelection.done, outcomes: beforeSelection.outcomes }, 'selection does not submit or create evidence');
  await page.setViewportSize({ width: 720, height: 320 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await grammarGeometry(page, 'choice task 720×320');
  await page.getByRole('button', { name: 'Проверить ответ', exact: true }).press('Enter');
  await page.locator('#g_review_title').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'g_review_title', 'feedback receives deterministic focus');
  assert.equal(await page.locator('#g_review_title').evaluate((heading) => {
    const target = heading.getBoundingClientRect();
    const area = document.querySelector('#g_area').getBoundingClientRect();
    return target.top >= area.top - 1 && target.bottom <= area.bottom + 1;
  }), true, 'feedback focus is inside the visible Grammar scroll row');
  assert.equal(await page.locator('.grammar-choice[role="radio"]:not(:disabled)').count(), 0,
    'submitted answer controls are genuinely disabled');
  assert.match(await page.locator('#g_feedback_status').innerText(), /Ответ (?:верный|неверный)/u,
    'dedicated live feedback is concise and textual');
  assert.ok(await page.locator('.grammar-choice__state').filter({ hasText: /ответ/u }).count() >= 1,
    'review retains a visible textual answer state');
  const committed = await page.evaluate(() => ({
    done: window.S.grammarRunner.done,
    outcomes: window.S.grammarRunner.itemOutcomes.length,
  }));
  assert.deepEqual(committed, { done: beforeSelection.done + 1, outcomes: beforeSelection.outcomes + 1 },
    'explicit submit commits exactly one outcome');
  await page.evaluate((token) => { window.gSubmitChoice(token); window.gSubmitChoice(token); }, beforeSelection.token);
  assert.deepEqual(await page.evaluate(() => ({
    done: window.S.grammarRunner.done,
    outcomes: window.S.grammarRunner.itemOutcomes.length,
  })), committed, 'repeat click/Enter attempts cannot double-submit the task');
  assert.equal(await page.locator('#g_review_title').evaluate((heading) => getComputedStyle(heading).outlineStyle), 'none',
    'programmatic feedback focus does not show a raw UA rectangle');
  const beforeNext = await page.evaluate(() => window.S.grammarRunner.i);
  await page.getByRole('button', { name: /Следующее задание|Завершить подход/u }).press('Enter');
  await page.evaluate(() => window.gAfterExplain());
  assert.equal(await page.evaluate(() => window.S.grammarRunner.i), beforeNext + 1, 'explicit Next advances exactly once');
  assert.match(await page.evaluate(() => document.activeElement?.id || ''), /^g_(?:choice_0|inp)$/u,
    'the next task hands focus to its answer control');
  assert.equal(await page.evaluate(() => {
    const target = document.activeElement?.getBoundingClientRect();
    const area = document.querySelector('#g_area')?.getBoundingClientRect();
    return Boolean(target && area && target.top >= area.top - 1 && target.bottom <= area.bottom + 1);
  }), true, 'the next answer control is visibly focused rather than only active off-screen');
  await page.evaluate(() => window.gToThemes());
  await page.locator('[data-grammar-dashboard]').waitFor();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: /Экзамен · задания 19–24/u }).press('Enter');
  await page.getByRole('button', { name: 'Начать', exact: true }).press('Enter');
  await page.locator('#g_ex_0').waitFor();
  const longExamAnswer = 'definitelywrong'.repeat(40);
  assert.equal(await page.locator('#g_ex_0').getAttribute('maxlength'), '200');
  await page.locator('#g_ex_0').fill(longExamAnswer);
  for (let index = 1; index < 6; index += 1) {
    await page.locator(`#g_ex_${index}`).fill(GRAMMAR_CATALOG.exams[0].gaps[index].ans[0]);
  }
  assert.equal(await page.evaluate(() => window.S.grammarRunner.schema), 'grammar-exam-runner-v1');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
    'mobile exam runner has no horizontal overflow');
  assert.deepEqual(await page.locator('#g_area input, #g_area button').evaluateAll((controls) => controls
    .map((control) => ({ label: control.getAttribute('aria-label') || control.textContent?.trim(), height: control.getBoundingClientRect().height }))
    .filter((control) => control.height < 44)), [], 'exam controls keep a 44px keyboard/touch target');
  await page.locator('#g_ex_0').press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'g_ex_1',
    'native exam inputs preserve keyboard order');
  await page.getByRole('button', { name: 'Проверить', exact: true }).press('Enter');
  await page.locator('#g_exam_result_title').filter({ hasText: /^5 из 6$/u }).waitFor({ timeout: 8_000 });
  assert.match(await page.locator('#g_area').innerText(), /слабые темы отмечены к повторению/u);
  assert.equal((await page.locator('.grammar-status').filter({ hasText: /Ваш ответ:/u }).innerText()).length <= 215, true,
    'exam result clamps the learner answer before rendering it');
  for (const viewport of [{ width: 320, height: 720 }, { width: 720, height: 320 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await grammarGeometry(page, `long exam result ${viewport.width}×${viewport.height}`);
  }
  assert.equal(await page.evaluate(() => window.S.grammarRunner), null);

  const canonical = await context.request.get(`${baseUrl}/api/v1/progress`, {
    headers: { 'X-EasyBoost-Expected-Owner': username },
  });
  assert.equal(canonical.ok(), true);
  const progress = await canonical.json();
  const firstGap = GRAMMAR_CATALOG.exams[0].gaps[0];
  assert.equal(progress.grammarMastery[String(firstGap.t)].stats.errors, 1);
  assert.equal(progress.grammarMastery[String(firstGap.t)].masteryHistory.at(-1).session.items
    .some((item) => item.topicId === firstGap.t && item.errorCode === 'word_or_verb_form'), true);
  assert.equal(progress.grammarMastery[String(GRAMMAR_CATALOG.exams[0].gaps[1].t)].stage, 'not_started',
    'correct exam work is history, not mastery credit');

  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: 'К темам', exact: true }).press('Enter');
  assert.match(await page.locator('[data-grammar-dashboard]').innerText(), /форма слова или глагола/u,
    'the dashboard surfaces the exact exam weakness even before a late-stage regression');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: /Экзамен · задания 19–24/u }).press('Enter');
  await page.getByRole('button', { name: 'Начать', exact: true }).press('Enter');
  await page.locator('#g_ex_0').fill('offline draft one');
  await page.locator('#g_ex_1').fill('offline draft two');
  const resumeIdentity = await page.evaluate(() => ({
    sessionId: window.S.grammarRunner.sessionId,
    answers: window.S.grammarRunner.answers.slice(0, 2),
  }));
  await context.setOffline(true);
  await page.evaluate(() => window.tab('scr1'));
  await openPracticeSkill(page, 'grammar');
  await page.locator('#g_ex_0').waitFor();
  assert.equal(await page.locator('#g_ex_0').inputValue(), 'offline draft one');
  assert.equal(await page.locator('#g_ex_1').inputValue(), 'offline draft two');
  assert.deepEqual(await page.evaluate(() => ({
    sessionId: window.S.grammarRunner.sessionId,
    answers: window.S.grammarRunner.answers.slice(0, 2),
  })), resumeIdentity, 'offline navigation restores the exact device-local session');
  await page.locator('#g_ex_0').fill('editable offline draft');
  assert.equal(await page.evaluate(() => window.S.grammarRunner.answers[0]), 'editable offline draft',
    'the restored in-memory exam remains editable after route hooks finish');
  await context.setOffline(false);
  await page.reload({ waitUntil: 'networkidle' });
  await openPracticeSkill(page, 'grammar');
  await page.locator('#g_ex_0').waitFor();
  assert.equal(await page.locator('#g_ex_0').inputValue(), 'editable offline draft');
  assert.equal(await page.evaluate(() => window.S.grammarRunner.sessionId), resumeIdentity.sessionId,
    'reload resumes the same exam identity');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
    'the complete desktop exam runner has no horizontal overflow');
  assert.deepEqual(await page.locator('#g_area input, #g_area button').evaluateAll((controls) => controls
    .map((control) => control.getBoundingClientRect().height).filter((height) => height < 44)), [],
  'desktop exam controls keep a 44px keyboard/touch target');

  const offlineForm = GRAMMAR_CATALOG.exams[1];
  for (let index = 0; index < 6; index += 1) {
    await page.locator(`#g_ex_${index}`).fill(offlineForm.gaps[index].ans[0]);
  }
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Проверить', exact: true }).press('Enter');
  await page.locator('#g_exam_result_title').filter({ hasText: /^6 из 6$/u }).waitFor({ timeout: 8_000 });
  const queued = await page.evaluate(() => window.EasyBoostSync.pendingGrammarMasteryEvents());
  assert.equal(queued.some((entry) => entry.event.id === resumeIdentity.sessionId), true,
    'offline completion first reaches the owner-scoped durable queue with the same UUID');
  assert.equal(await page.evaluate(() => window.S.grammarRunner), null,
    'a durably queued completion clears only the device-local runner');

  await context.setOffline(false);
  await page.evaluate(() => window.EasyBoostSync.flush());
  await page.waitForFunction((sessionId) => !window.EasyBoostSync.pendingGrammarMasteryEvents()
    .some((entry) => entry.event.id === sessionId), resumeIdentity.sessionId, { timeout: 8_000 });
  const synchronized = await context.request.get(`${baseUrl}/api/v1/progress`, {
    headers: { 'X-EasyBoost-Expected-Owner': username },
  });
  assert.equal(synchronized.ok(), true);
  const synchronizedProgress = await synchronized.json();
  for (const topicId of new Set(offlineForm.gaps.map((gap) => gap.t))) {
    assert.equal(synchronizedProgress.grammarMastery[String(topicId)].masteryHistory
      .filter((entry) => entry.eventId === resumeIdentity.sessionId).length, 1,
    `reconnect writes the offline exam evidence once for topic ${topicId}`);
  }
  assert.deepEqual(pageErrors, []);
  console.log('Grammar 2.0 release E2E passed at 320×720, 720×320, 375px and desktop with Paper A, keyboard, reduced motion, offline resume and queued reconnect');
} finally {
  if (context) await context.close();
  if (browser) await browser.close();
  if (child) await stopProcess(child);
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
