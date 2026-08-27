import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import {
  availablePort, chromeExecutable, createActiveSubscriptionPage, stopProcess, waitForReady,
} from './browser-server-harness.js';
import { getEgeMockForm } from '../ege-mock/catalog.js';
import { createFileRepository } from '../storage/file-repository.js';
import { completeEgeMockOralStageLedger } from '../test/support/ege-mock-attempt-contract.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const username = 'aisy-ege-hub-user';
const failureUsername = 'aisy-ege-lazy-recovery-user';
const jwtSecret = 'aisy-ege-hub-e2e-secret-32-characters';
const matrixViewports = [
  { width: 320, height: 720, label: '320×720' },
  { width: 375, height: 812, label: '375×812' },
  { width: 768, height: 1024, label: '768×1024' },
  { width: 1440, height: 900, label: '1440×900' },
  { width: 844, height: 390, label: '844×390 landscape' },
];
const mutation = (body) => ({
  ...body,
  idempotencyKey: crypto.randomUUID(),
  requestHash: crypto.randomBytes(32).toString('hex'),
});

async function paperExamMetrics(page, { scrollPrimary = true } = {}) {
  await page.locator('.ege-mock__back').focus();
  if (scrollPrimary) {
    await page.locator('.ege-mock__action--primary').last().evaluate((control) => {
      control.scrollIntoView({ block: 'center', inline: 'nearest' });
    });
  }
  return page.evaluate(() => {
    const rect = (node) => {
      const value = node?.getBoundingClientRect();
      return value ? { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height } : null;
    };
    const overlaps = (first, second) => first && second
      && first.left < second.right && first.right > second.left
      && first.top < second.bottom && first.bottom > second.top;
    const frame = document.getElementById('frame');
    const primary = document.querySelector('#scr16.on .ege-mock__action--primary');
    const launcher = document.getElementById('asya-launcher');
    const primaryStyle = primary ? getComputedStyle(primary) : null;
    const affordance = primary ? getComputedStyle(primary, '::after') : null;
    const back = document.querySelector('#scr16.on .ege-mock__back');
    const focus = back ? getComputedStyle(back) : null;
    const controls = Array.from(document.querySelectorAll(
      '#scr16.on button, #scr16.on select, #scr16.on textarea, #scr16.on input[type="text"], #scr16.on summary',
    )).filter((node) => node.getClientRects().length).map((node) => ({
      ...rect(node), label: node.getAttribute('aria-label') || (node.textContent || '').trim().slice(0, 60),
    }));
    const fields = Array.from(document.querySelectorAll(
      '#scr16.on select, #scr16.on textarea, #scr16.on input[type="text"]',
    )).filter((node) => node.getClientRects().length).map((node) => Number.parseFloat(getComputedStyle(node).fontSize));
    const choices = Array.from(document.querySelectorAll('#scr16.on .ege-mock__choice'))
      .filter((node) => node.getClientRects().length).map(rect);
    const choiceInput = document.querySelector('#scr16.on .ege-mock__choice input');
    const chromeBottom = document.querySelector('#scr16.on .ege-mock__top')?.getBoundingClientRect().bottom || 0;
    const salient = Array.from(document.querySelectorAll(
      '#scr16.on .ege-mock__fact, #scr16.on .ege-mock__status, #scr16.on .ege-mock__action',
    )).filter((node) => node.getClientRects().length).map((node) => ({
      ...rect(node), label: (node.textContent || '').trim().slice(0, 80),
    }))
      .filter((item) => item.bottom > chromeBottom)
      .map((item) => ({ ...item, top: Math.max(item.top, chromeBottom) }));
    const chromeControls = Array.from(document.querySelectorAll(
      '#scr16.on .ege-mock__back, #scr16.on .ege-mock__timer',
    )).filter((node) => node.getClientRects().length).map(rect);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      documentWidth: document.documentElement.scrollWidth,
      frame: rect(frame),
      theme: document.documentElement.dataset.theme || 'system',
      background: getComputedStyle(document.querySelector('.ege-mock')).backgroundColor,
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      backs: Array.from(document.querySelectorAll('[aria-label="Назад в раздел ЕГЭ"]')).filter((node) => node.getClientRects().length).length,
      nav: { hidden: document.getElementById('aisy-shell-nav').hidden, inert: document.getElementById('aisy-shell-nav').inert },
      primaryCount: document.querySelectorAll('#scr16.on .ege-mock__action--primary').length,
      primary: primary ? {
        ...rect(primary), radius: primaryStyle.borderRadius, paddingLeft: primaryStyle.paddingLeft,
        paddingRight: primaryStyle.paddingRight, background: primaryStyle.backgroundColor,
        affordanceWidth: affordance.width,
        affordanceHeight: affordance.height, transform: primaryStyle.transform,
      } : null,
      asyaOverlap: launcher && !launcher.hidden ? salient.some((item) => overlaps(item, rect(launcher))) : false,
      asyaOverlapLabels: launcher && !launcher.hidden
        ? salient.filter((item) => overlaps(item, rect(launcher))).map((item) => ({
          label: item.label, rect: item,
        })) : [],
      asyaRect: launcher && !launcher.hidden ? rect(launcher) : null,
      chromeBottom,
      asyaChromeOverlap: launcher && !launcher.hidden
        ? chromeControls.some((item) => overlaps(item, rect(launcher))) : false,
      controls,
      fields,
      choices,
      choiceInput: choiceInput ? rect(choiceInput) : null,
      focus: focus ? { style: focus.outlineStyle, width: focus.outlineWidth } : null,
    };
  });
}

async function paperDialogMetrics(page) {
  return page.evaluate(() => {
    const rect = (node) => {
      const value = node.getBoundingClientRect();
      return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
    };
    const dialog = document.getElementById('ege_mock_confirm_dialog');
    const paper = dialog.querySelector('.ege-mock__confirm-paper');
    const primary = document.getElementById('ege_mock_confirm_accept');
    const cancel = document.getElementById('ege_mock_confirm_cancel');
    const primaryStyle = getComputedStyle(primary);
    const affordance = getComputedStyle(primary, '::after');
    return {
      dialog: rect(dialog), paper: rect(paper), primary: rect(primary), cancel: rect(cancel),
      open: dialog.open,
      focusId: document.activeElement?.id,
      colorScheme: getComputedStyle(dialog).colorScheme,
      primaryStyle: {
        radius: primaryStyle.borderRadius, paddingLeft: primaryStyle.paddingLeft,
        paddingRight: primaryStyle.paddingRight, background: primaryStyle.backgroundColor,
        affordanceWidth: affordance.width, affordanceHeight: affordance.height,
      },
    };
  });
}

let browser;
let child;
let context;
let temporaryDirectory;
try {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'aisy-ege-hub-'));
  const dataFile = path.join(temporaryDirectory, 'data.json');
  const createdAt = Date.now();
  await fs.writeFile(dataFile, JSON.stringify({
    users: Object.fromEntries([username, failureUsername].map((owner) => [owner, {
      created: createdAt,
      sub_until: createdAt + 86_400_000,
      privacy_consent: {
        text_processing: true,
        voice_processing: false,
        policy_version: '2026-08-26-vk-id-v1',
        updated_at: new Date(createdAt).toISOString(),
      },
    }])),
    progress: { [username]: {}, [failureUsername]: {} },
  }), 'utf8');
  const repository = createFileRepository(dataFile);
  const form = getEgeMockForm('ege-en-2026-form-1', 1);
  const started = await repository.startEgeMockAttempt(username, mutation({
    formId: form.id, formRevision: form.revision, catalogFingerprint: form.fingerprint,
  }));
  const written = await repository.submitEgeMockWritten(username, started.attempt.id, mutation({
    expectedRevision: started.attempt.revision,
  }));
  const oral = await repository.startEgeMockOral(username, started.attempt.id, mutation({
    expectedRevision: written.attempt.revision,
  }));
  const staged = await completeEgeMockOralStageLedger(repository, username, oral, mutation);
  await repository.submitEgeMockOral(username, started.attempt.id, mutation({
    expectedRevision: staged.attempt.revision,
  }));

  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  child = spawn(process.execPath, [serverPath], {
    cwd: projectDirectory,
    env: {
      ...process.env, NODE_ENV: 'test', PORT: String(port), APP_URL: baseUrl,
      DATABASE_PROVIDER: 'file', DATA_FILE: dataFile, JWT_SECRET: jwtSecret,
      TELEGRAM_BOT_TOKEN: '', ADMIN_TELEGRAM_ID: '', XAI_ENABLED: 'false',
      VOICE_TUTOR_ENABLED: 'false', ADAPTIVE_LEARNING_ENABLED: 'false',
      SPEAKING_PRONUNCIATION_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  await waitForReady(baseUrl, child, output);

  browser = await chromium.launch({ headless: true, executablePath: await chromeExecutable() });
  const harness = await createActiveSubscriptionPage(browser, {
    baseUrl, username, jwtSecret,
    contextOptions: { viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' },
  });
  context = harness.context;
  const page = harness.page;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, { timeout: 15_000 });

  await page.route('**/api/v1/ege-mocks/attempts/current', (route) => route.fulfill({
    status: 503, contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'TEMPORARILY_UNAVAILABLE' } }),
  }));
  try {
    await page.getByRole('button', { name: 'ЕГЭ', exact: true }).press('Enter');
  } catch (error) {
    throw new Error(`${error.message}\nPage errors: ${pageErrors.join(' | ')}\nVisible page: ${await page.locator('body').innerText()}`);
  }
  await page.locator('#aisy-ege.on').waitFor();
  await page.getByRole('button', { name: 'Повторить' }).waitFor();
  assert.equal(await page.getByRole('button', {
    name: 'Открыть подготовку к пробнику',
  }).isDisabled(), true, 'an unknown current attempt must fail closed before a new start');
  await page.unroute('**/api/v1/ege-mocks/attempts/current');
  await page.getByRole('button', { name: 'Повторить' }).press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#ege-hub-sections > li').length === 5);
  assert.equal(await page.locator('#scr16.on').count(), 0,
    'top-level EGE navigation must open the hub, not the timed runner');
  const hubText = await page.locator('#aisy-ege').innerText();
  assert.match(hubText, /38 письменных заданий за 190 минут/u);
  assert.match(hubText, /устная часть на 17 минут/u);
  assert.match(hubText, /экспериментальную приблизительную оценку/u);
  assert.doesNotMatch(hubText, /подсказк|правильн.*ответ|Ася/iu);
  assert.equal(await page.locator('#ege-hub-sections > li').count(), 5);
  assert.deepEqual(await page.locator('#ege-hub-sections h3').allTextContents(), [
    'Аудирование', 'Чтение', 'Грамматика и лексика', 'Письмо', 'Говорение',
  ]);
  assert.deepEqual(await page.locator('#aisy-ege button:visible').evaluateAll((buttons) => (
    buttons.filter((button) => button.getBoundingClientRect().height < 44).map((button) => button.textContent)
  )), []);
  for (const viewport of matrixViewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const hubMetrics = await page.evaluate(() => {
      const frame = document.getElementById('frame').getBoundingClientRect();
      const full = document.getElementById('ege-hub-full-mock').getBoundingClientRect();
      const rows = Array.from(document.querySelectorAll('#ege-hub-sections > li')).map((row) => row.getBoundingClientRect().height);
      const nav = document.getElementById('aisy-shell-nav');
      return {
        documentWidth: document.documentElement.scrollWidth,
        frameWidth: frame.width,
        fullHeight: full.height,
        maximumRowHeight: Math.max(...rows),
        primaryCount: document.querySelectorAll('#aisy-ege.on .aisy-button:not(.aisy-button--secondary)').length,
        nav: { hidden: nav.hidden, inert: nav.inert },
      };
    });
    assert.ok(hubMetrics.documentWidth <= viewport.width, `${viewport.label}: hub has no horizontal overflow`);
    assert.ok(hubMetrics.frameWidth <= 390.5, `${viewport.label}: hub remains a portrait phone`);
    assert.ok(hubMetrics.fullHeight > hubMetrics.maximumRowHeight * 1.6, `${viewport.label}: full mock remains the dominant sheet`);
    assert.equal(hubMetrics.primaryCount, 1, `${viewport.label}: hub has one coral primary`);
    assert.deepEqual(hubMetrics.nav, { hidden: false, inert: false }, `${viewport.label}: top-level nav stays at the bottom`);
  }
  await page.setViewportSize({ width: 375, height: 812 });

  await page.getByRole('button', { name: /Открыть результат: Диагностический/u }).first().press('Enter');
  await page.getByRole('heading', { name: /^0–(?:20|40) из 82$/u }).waitFor({ timeout: 15_000 });
  assert.equal(await page.getByRole('button', { name: 'Начать тренировочный повтор' }).count(), 1,
    'the exact result keeps its existing explicit training-repeat action');
  await page.getByRole('button', { name: 'Назад в раздел ЕГЭ' }).press('Enter');
  await page.locator('#aisy-ege.on').waitFor();

  await page.getByRole('button', { name: 'Открыть подготовку к пробнику' }).press('Enter');
  await page.locator('#scr16.on').waitFor();
  for (const viewport of [
    { width: 390, height: 844, label: '390×844 intro' },
    { width: 844, height: 390, label: '844×390 intro landscape' },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const introMetrics = await paperExamMetrics(page, { scrollPrimary: false });
    assert.ok(introMetrics.documentWidth <= viewport.width, `${viewport.label}: no horizontal overflow`);
    assert.ok(introMetrics.frame.width <= 390.5, `${viewport.label}: intro remains in the portrait canvas`);
    assert.equal(introMetrics.primaryCount, 1, `${viewport.label}: intro has one primary action`);
    assert.equal(Math.round(introMetrics.primary.height), 58, `${viewport.label}: intro CTA height`);
    assert.equal(introMetrics.primary.background, 'rgb(185, 67, 58)', `${viewport.label}: intro CTA is canonical coral`);
    assert.equal(introMetrics.asyaOverlap, false, `${viewport.label}: Asya does not cover intro facts, status or CTA`);
    assert.equal(introMetrics.asyaChromeOverlap, false, `${viewport.label}: Asya does not cover Back or timer`);
  }
  await page.setViewportSize({ width: 320, height: 720 });
  await page.getByRole('button', { name: 'Проверить готовность' }).press('Enter');
  try {
    await page.getByRole('button', { name: 'Начать письменную часть' }).waitFor({ timeout: 15_000 });
  } catch (error) {
    throw new Error(`${error.message}\nEGE runner: ${await page.locator('#ege_mock_area').innerText()}\nPage errors: ${pageErrors.join(' | ')}`);
  }
  await page.getByRole('button', { name: 'Начать письменную часть' }).press('Enter');
  await page.getByRole('button', { name: 'Задание 1, пропущено' }).waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const screen = document.getElementById('scr16');
    const heading = document.querySelector('#ege_mock_area .ege-mock__task h2');
    const chrome = document.querySelector('#scr16.on .ege-mock__top');
    if (!screen || !heading || !chrome) return false;
    const headingRect = heading.getBoundingClientRect();
    return screen.scrollTop === 0 && document.activeElement === heading
      && headingRect.top >= chrome.getBoundingClientRect().bottom
      && headingRect.bottom <= innerHeight;
  }, null, { timeout: 15_000 });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: 'Назад в раздел ЕГЭ' }).press('Enter');
  await page.locator('#aisy-ege.on').waitFor();
  await page.getByRole('button', { name: 'Продолжить пробник' }).waitFor({ timeout: 15_000 });
  assert.equal(await page.getByRole('button', { name: 'Открыть подготовку к пробнику' }).isDisabled(), true);
  await page.getByRole('button', { name: /Открыть результат: Диагностический/u }).first().press('Enter');
  await page.getByRole('heading', { name: /^0–(?:20|40) из 82$/u }).waitFor({ timeout: 15_000 });
  assert.equal(await page.getByRole('button', { name: 'Начать тренировочный повтор' }).count(), 0,
    'a historical result must not offer a conflicting repeat while an attempt is active');
  await page.getByRole('button', { name: 'Назад в раздел ЕГЭ' }).press('Enter');
  await page.getByRole('button', { name: 'Продолжить пробник' }).waitFor({ timeout: 15_000 });

  await context.setOffline(true);
  await page.getByText(/Нет сети.*таймер продолжает идти/u).waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Продолжить пробник' }).press('Enter');
  await page.locator('#scr16.on').waitFor();
  await page.waitForFunction(() => !document.querySelector('#ege_mock_area')?.textContent
    ?.includes('Сессия обновлена'), null, { timeout: 15_000 });
  assert.match(await page.locator('#ege_mock_area').innerText(), /Задание 1|сохран|состояние/u);
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Задание 3, пропущено' }).press('Enter');
  await page.locator('.ege-mock__back').focus();
  await page.keyboard.press('Tab');
  assert.deepEqual(await page.evaluate(() => ({
    inTask: Boolean(document.activeElement?.closest('.ege-mock__task')),
    inReview: Boolean(document.activeElement?.closest('.ege-mock__review')),
  })), { inTask: true, inReview: false }, 'Tab enters the current task before the 36-button review grid');
  await page.locator('.ege-mock__choice input').first().focus();
  assert.equal(await page.locator('.ege-mock__choice').first().evaluate((choice) => (
    getComputedStyle(choice.querySelector('span')).outlineStyle
  )), 'solid', 'radio choice exposes its visible focus ring on the Paper surface');

  const backgrounds = new Map();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((preference) => window.AisyTheme.set(preference), theme);
    for (const viewport of matrixViewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const metrics = await paperExamMetrics(page);
      backgrounds.set(theme, metrics.background);
      assert.ok(metrics.documentWidth <= metrics.viewport.width, `${theme} ${viewport.label}: no horizontal overflow`);
      assert.ok(metrics.frame.width <= 390.5, `${theme} ${viewport.label}: portrait canvas remains <=390px`);
      assert.equal(metrics.backs, 1, `${theme} ${viewport.label}: exactly one exam Back`);
      assert.deepEqual(metrics.nav, { hidden: true, inert: true }, `${theme} ${viewport.label}: bottom nav stays hidden`);
      assert.equal(metrics.primaryCount, 1, `${theme} ${viewport.label}: exactly one coral primary`);
      assert.equal(Math.round(metrics.primary.height), 58, `${theme} ${viewport.label}: CTA height`);
      assert.equal(Math.round(Number.parseFloat(metrics.primary.radius)), 28, `${theme} ${viewport.label}: CTA radius`);
      assert.equal(Math.round(Number.parseFloat(metrics.primary.paddingLeft)), 26, `${theme} ${viewport.label}: CTA left padding`);
      assert.equal(Math.round(Number.parseFloat(metrics.primary.paddingRight)), 10, `${theme} ${viewport.label}: CTA right padding`);
      assert.equal(Math.round(Number.parseFloat(metrics.primary.affordanceWidth)), 38, `${theme} ${viewport.label}: affordance width`);
      assert.equal(Math.round(Number.parseFloat(metrics.primary.affordanceHeight)), 38, `${theme} ${viewport.label}: affordance height`);
      assert.equal(metrics.primary.background, 'rgb(185, 67, 58)', `${theme} ${viewport.label}: CTA uses canonical coral`);
      assert.equal(metrics.asyaOverlap, false,
        `${theme} ${viewport.label}: Asya must not cover content (${JSON.stringify({ overlaps: metrics.asyaOverlapLabels, launcher: metrics.asyaRect, chromeBottom: metrics.chromeBottom })})`);
      assert.equal(metrics.asyaChromeOverlap, false, `${theme} ${viewport.label}: Asya must not cover exam chrome`);
      assert.equal(metrics.controls.every((control) => control.width >= 44 && control.height >= 44), true,
        `${theme} ${viewport.label}: all controls remain >=44px (${JSON.stringify(metrics.controls.filter((control) => control.width < 44 || control.height < 44))})`);
      assert.equal(metrics.choices.every((choice) => choice.width >= 44 && choice.height >= 44), true,
        `${theme} ${viewport.label}: every choice row is a >=44px target`);
      assert.ok(metrics.choiceInput && metrics.choiceInput.height <= 20.5,
        `${theme} ${viewport.label}: radio visual does not overflow its choice row`);
      assert.equal(metrics.fields.every((fontSize) => fontSize >= 16), true, `${theme} ${viewport.label}: fields remain >=16px`);
      assert.equal(metrics.focus.style, 'solid', `${theme} ${viewport.label}: Back has visible focus`);
      assert.ok(Number.parseFloat(metrics.focus.width) >= 3, `${theme} ${viewport.label}: focus ring width`);
      assert.equal(metrics.reduced, true, `${theme} ${viewport.label}: reduced motion remains active`);
      assert.equal(metrics.primary.transform, 'none', `${theme} ${viewport.label}: reduced motion removes spatial CTA transform`);

      const submitTrigger = page.locator('[data-ege-action="complete-objective"]');
      await submitTrigger.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Завершить задания 1–36?' });
      await dialog.waitFor({ state: 'visible' });
      const dialogMetrics = await paperDialogMetrics(page);
      assert.equal(dialogMetrics.open, true, `${theme} ${viewport.label}: confirmation opens`);
      assert.equal(dialogMetrics.focusId, 'ege_mock_confirm_cancel', `${theme} ${viewport.label}: least destructive action receives focus`);
      assert.ok(dialogMetrics.dialog.left >= metrics.frame.left - 1 && dialogMetrics.dialog.right <= metrics.frame.right + 1,
        `${theme} ${viewport.label}: dialog stays inside portrait stage`);
      assert.ok(dialogMetrics.dialog.top >= 0 && dialogMetrics.dialog.bottom <= viewport.height + 1,
        `${theme} ${viewport.label}: dialog stays vertically reachable`);
      assert.equal(Math.round(dialogMetrics.primary.height), 58, `${theme} ${viewport.label}: confirmation CTA height`);
      assert.equal(Math.round(Number.parseFloat(dialogMetrics.primaryStyle.radius)), 28, `${theme} ${viewport.label}: confirmation CTA radius`);
      assert.equal(Math.round(Number.parseFloat(dialogMetrics.primaryStyle.paddingLeft)), 26, `${theme} ${viewport.label}: confirmation CTA left padding`);
      assert.equal(Math.round(Number.parseFloat(dialogMetrics.primaryStyle.paddingRight)), 10, `${theme} ${viewport.label}: confirmation CTA right padding`);
      assert.equal(Math.round(Number.parseFloat(dialogMetrics.primaryStyle.affordanceWidth)), 38, `${theme} ${viewport.label}: confirmation affordance width`);
      assert.equal(Math.round(Number.parseFloat(dialogMetrics.primaryStyle.affordanceHeight)), 38, `${theme} ${viewport.label}: confirmation affordance height`);
      assert.equal(dialogMetrics.primaryStyle.background, 'rgb(185, 67, 58)', `${theme} ${viewport.label}: confirmation uses canonical coral`);
      assert.ok(dialogMetrics.cancel.width >= 44 && dialogMetrics.cancel.height >= 44, `${theme} ${viewport.label}: cancel touch target`);
      assert.equal(dialogMetrics.colorScheme, theme, `${theme} ${viewport.label}: dialog inherits theme`);
      await page.locator('#ege_mock_confirm_dialog').press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.egeAction), 'complete-objective',
        `${theme} ${viewport.label}: Escape restores trigger focus`);
    }
  }
  assert.notEqual(backgrounds.get('light'), backgrounds.get('dark'), 'strict mock maps light and warm-dark paper separately');
  await page.getByRole('button', { name: 'Назад в раздел ЕГЭ' }).press('Enter');
  await page.locator('#aisy-ege.on').waitFor();
  assert.equal(await page.locator('#scr16.on').count(), 0, 'one exam Back click returns to the EGE hub after repeated confirmations');
  assert.deepEqual(pageErrors, []);

  await context.close();
  context = null;
  const failureHarness = await createActiveSubscriptionPage(browser, {
    baseUrl, username: failureUsername, jwtSecret,
    contextOptions: { viewport: { width: 390, height: 844 }, serviceWorkers: 'block' },
  });
  context = failureHarness.context;
  const failurePage = failureHarness.page;
  const failurePageErrors = [];
  failurePage.on('pageerror', (error) => failurePageErrors.push(error.message));
  await failurePage.goto(baseUrl, { waitUntil: 'networkidle' });
  await failurePage.getByRole('button', { name: 'ЕГЭ', exact: true }).press('Enter');
  await failurePage.locator('#aisy-ege.on').waitFor();
  await failurePage.getByRole('button', { name: 'Открыть подготовку к пробнику' }).waitFor({ timeout: 15_000 });
  await failurePage.route('**/*ege-mock*.js', (route) => route.fulfill({
    status: 503,
    contentType: 'text/javascript',
    body: 'throw new Error("EGE_MOCK_CHUNK_UNAVAILABLE")',
  }));
  await failurePage.getByRole('button', { name: 'Открыть подготовку к пробнику' }).press('Enter');
  await failurePage.getByText(/Не удалось открыть пробник/u).waitFor({ timeout: 15_000 });
  assert.equal(await failurePage.locator('#aisy-ege.on').count(), 1,
    'a failed lazy runner load stays on the safe EGE hub');
  const recovery = failurePage.getByRole('button', { name: 'Перезагрузить приложение' });
  assert.equal(await recovery.count(), 1,
    'a failed lazy runner load offers an explicit recovery action');
  await failurePage.unroute('**/*ege-mock*.js');
  await Promise.all([
    failurePage.waitForNavigation({ waitUntil: 'networkidle' }),
    recovery.press('Enter'),
  ]);
  await failurePage.getByRole('button', { name: 'ЕГЭ', exact: true }).press('Enter');
  await failurePage.getByRole('button', { name: 'Открыть подготовку к пробнику' }).waitFor({ timeout: 15_000 });
  await failurePage.getByRole('button', { name: 'Открыть подготовку к пробнику' }).press('Enter');
  await failurePage.locator('#scr16.on').waitFor({ timeout: 15_000 });
  await failurePage.getByRole('button', { name: 'Проверить готовность' }).waitFor({ timeout: 15_000 });
  assert.match(await failurePage.locator('#ege_mock_area').innerText(), /190 минут|Проверить готовность/u,
    'reload recovery returns to the safe strict-mock preparation state');
  assert.equal(await failurePage.locator('#ege_mock_timer').getAttribute('aria-label'), 'Таймер не запущен',
    'reload recovery does not start or invent timer state');
  assert.deepEqual(failurePageErrors, [], 'lazy-load failure and recovery stay handled');
  console.log('Aisy EGE hub E2E passed: hub navigation, exact result, strict start/continue and offline recovery');
} finally {
  if (context) await context.close();
  if (browser) await browser.close();
  await stopProcess(child);
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
