import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  availablePort, chromeExecutable, createActiveSubscriptionPage, stopProcess, waitForReady,
} from './browser-server-harness.js';

const projectDirectory = fileURLToPath(new URL('..', import.meta.url));
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
const jwtSecret = 'aisy-progress-profile-e2e-secret-32';
const overviewPattern = '**/api/v1/adaptive-learning/overview';
const viewports = [
  { label: '320×720', width: 320, height: 720 },
  { label: '375×812', width: 375, height: 812 },
  { label: '390×844', width: 390, height: 844 },
  { label: '768×1024', width: 768, height: 1024 },
  { label: '1440×900', width: 1440, height: 900 },
  { label: '844×390 landscape', width: 844, height: 390 },
];

function contrastRatio(first, second) {
  const parse = (value) => (value.match(/[\d.]+/gu) || []).slice(0, 3).map(Number);
  const luminance = (value) => {
    const channels = parse(value).map((channel) => {
      const normalized = channel / 255;
      return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
    });
    return (.2126 * channels[0]) + (.7152 * channels[1]) + (.0722 * channels[2]);
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + .05) / (values[1] + .05);
}

async function waitForFocus(page, id) {
  await page.waitForFunction((expected) => document.activeElement?.id === expected, id);
}

let browser;
let child;
let temporaryDirectory;
try {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'aisy-progress-profile-'));
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataFile = path.join(temporaryDirectory, 'data.json');
  const now = Date.now();
  await fs.writeFile(dataFile, JSON.stringify({
    users: {
      learner: {
        created: now,
        sub_until: now + 7 * 86_400_000,
        privacy_consent: {
          text_processing: true,
          voice_processing: true,
          policy_version: '2026-08-26-vk-id-v1',
          updated_at: new Date(now).toISOString(),
        },
      },
    },
    progress: { learner: {} },
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
      JWT_SECRET: jwtSecret,
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
  const { context, page } = await createActiveSubscriptionPage(browser, {
    baseUrl, username: 'learner', jwtSecret,
    contextOptions: {
      viewport: { width: 320, height: 720 },
      reducedMotion: 'reduce',
      serviceWorkers: 'block',
    },
  });
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 10_000 });
  const navigation = page.getByRole('navigation', { name: 'Основные разделы' });
  const progressButton = navigation.getByRole('button', { name: 'Прогресс', exact: true });
  const profileButton = navigation.getByRole('button', { name: 'Профиль', exact: true });

  let releaseOverview;
  let announceOverview;
  const overviewPaused = new Promise((resolve) => { releaseOverview = resolve; });
  const overviewRequested = new Promise((resolve) => { announceOverview = resolve; });
  let pauseFirstOverview = true;
  await page.route(overviewPattern, async (route) => {
    if (pauseFirstOverview) {
      pauseFirstOverview = false;
      announceOverview();
      await overviewPaused;
    }
    await route.continue();
  });
  await progressButton.click();
  const progress = page.locator('#scr10.on');
  await progress.waitFor({ state: 'visible' });
  await overviewRequested;
  assert.equal(await progress.locator('#progress_guidance').getAttribute('data-state'), 'loading');
  assert.equal(await progress.locator('#progress_guidance').getAttribute('aria-busy'), 'true');
  releaseOverview();
  await progress.locator('#progress_guidance[data-state="empty"][aria-busy="false"]')
    .waitFor({ state: 'visible', timeout: 10_000 });
  await page.unroute(overviewPattern);

  assert.equal(await progress.getByRole('heading', { name: 'Прогресс', exact: true }).count(), 1);
  assert.equal(await progress.locator('#progress_evidence_legend > li').count(), 3);
  const progressText = await progress.innerText();
  assert.match(progressText, /Изменение результата.*Что требует внимания.*Следующий шаг/isu);
  assert.match(progressText, /Самостоятельно.*С помощью.*Ориентировочно/su);
  assert.match(progressText, /сравнени/iu);
  assert.doesNotMatch(progressText, /Что улучшилось|Base|IELTS|🔥/u);
  await page.waitForFunction(() => Object.keys(localStorage)
    .some((key) => key.startsWith('easyboost.adaptive.overview.v1:')));

  const cta = progress.locator('#progress_next_action');
  const ctaState = await cta.evaluate((button) => ({
    disabled: button.disabled,
    ariaDisabled: button.getAttribute('aria-disabled'),
    text: button.textContent,
    html: button.outerHTML,
  }));
  assert.equal(ctaState.disabled, false, `settled Progress CTA must be enabled: ${JSON.stringify(ctaState)}; errors=${pageErrors.join(' | ')}`);
  assert.equal(ctaState.ariaDisabled, null, `settled Progress CTA must not be aria-disabled: ${JSON.stringify(ctaState)}`);
  assert.equal(await progress.getByRole('button', { name: ctaState.text.trim(), exact: true }).count(), 1,
    'the visual arrow affordance must not change the primary button accessible name');
  await page.waitForFunction(() => (
    getComputedStyle(document.getElementById('progress_next_action')).backgroundColor
      === 'rgb(185, 67, 58)'
  ));
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => window.AisyTheme.set(value), theme);
    const geometry = await cta.evaluate((button) => {
      const style = getComputedStyle(button);
      const affordance = getComputedStyle(button, '::after');
      const rect = button.getBoundingClientRect();
      return {
        height: rect.height,
        radius: Number.parseFloat(style.borderRadius),
        paddingStart: Number.parseFloat(style.paddingInlineStart),
        paddingEnd: Number.parseFloat(style.paddingInlineEnd),
        fontSize: Number.parseFloat(style.fontSize),
        background: style.backgroundColor,
        foreground: style.color,
        backgroundToken: style.getPropertyValue('--aisy-button-background').trim(),
        primaryToken: style.getPropertyValue('--aisy-color-primary').trim(),
        affordanceSize: Number.parseFloat(affordance.width),
        affordanceBackground: affordance.backgroundColor,
      };
    });
    assert.equal(geometry.height, 58, `${theme} CTA height`);
    assert.equal(geometry.radius, 28, `${theme} CTA radius`);
    assert.equal(geometry.paddingStart, 26, `${theme} CTA start padding`);
    assert.equal(geometry.paddingEnd, 10, `${theme} CTA end padding`);
    assert.equal(geometry.fontSize, 16, `${theme} CTA type`);
    assert.equal(geometry.background, 'rgb(185, 67, 58)', `${theme} CTA coral: ${JSON.stringify(geometry)}`);
    assert.equal(geometry.affordanceSize, 38, `${theme} CTA affordance`);
    assert.equal(geometry.affordanceBackground, 'rgb(255, 253, 249)', `${theme} CTA cream affordance`);
    assert.ok(contrastRatio(geometry.foreground, geometry.background) >= 4.5,
      `${theme} CTA text must meet AA`);
  }
  await cta.hover();
  await page.waitForFunction(() => (
    getComputedStyle(document.getElementById('progress_next_action')).backgroundColor
      === 'rgb(159, 52, 47)'
  ));
  await page.mouse.move(0, 0);

  await profileButton.click();
  const profile = page.locator('#scr11.on');
  await profile.waitFor({ state: 'visible' });
  await profile.locator('#privacyProfileButton').waitFor({ state: 'visible' });
  await profile.locator('#pf_plan_name').filter({ hasText: 'Активный доступ' }).waitFor();
  assert.equal(await profile.locator('[data-profile-group]').count(), 5);
  assert.match(await profile.locator('#pf_plan_summary').innerText(), /учебный доступ активен/u);
  const profileText = await profile.innerText();
  assert.match(profileText, /Ученик.*Предпочтения.*Доступ.*Ася и приватность.*Аккаунт и данные/sui);
  assert.match(profileText, /микрофон.*внешнему AI-провайдеру/su);
  assert.match(profileText, /Скачать мои данные.*Удалить аккаунт.*Выйти/su);
  assert.doesNotMatch(profileText, /Base|Free|демо|родител|преподавател|учител/iu);

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => new Promise((resolve) => {
        window.AisyTheme.set(value);
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }), theme);
      for (const destination of [
        { button: progressButton, selector: '#scr10.on' },
        { button: profileButton, selector: '#scr11.on' },
      ]) {
        await destination.button.click();
        await page.locator(destination.selector).waitFor({ state: 'visible' });
        if (destination.selector === '#scr10.on') {
          await page.locator('#scr10.on #progress_guidance[aria-busy="false"]')
            .waitFor({ state: 'visible', timeout: 10_000 });
        }
        const layout = await page.evaluate((selector) => {
          const active = document.querySelector(selector);
          const frame = document.getElementById('frame').getBoundingClientRect();
          const nav = document.getElementById('aisy-shell-nav').getBoundingClientRect();
          const launcher = document.getElementById('asya-launcher');
          const launcherRect = launcher.getBoundingClientRect();
          const navList = document.querySelector('.aisy-shell-nav__list');
          const controls = [...active.querySelectorAll('button,input,select,textarea,a[href]')]
            .filter((control) => control.getClientRects().length && !control.disabled)
            .map((control) => {
              const rect = control.getBoundingClientRect();
              return { id: control.id, width: rect.width, height: rect.height };
            });
          const visiblePrimary = [...active.querySelectorAll('.aisy-button:not(.aisy-button--secondary)')]
            .filter((control) => control.getClientRects().length).length;
          const overlapsLauncher = [...active.querySelectorAll(
            '.paper-page-header :is(h1,p),.progress-guidance article,.progress-guidance article :is(h2,p),[data-profile-group],[data-profile-group] :is(h2,p,strong,span,label,button)',
          )].filter((element) => {
            if (!element.getClientRects().length || launcher.hidden) return false;
            const rect = element.getBoundingClientRect();
            return rect.left < launcherRect.right && rect.right > launcherRect.left
              && rect.top < launcherRect.bottom && rect.bottom > launcherRect.top;
          }).map((element) => element.id || element.className || element.tagName);
          return {
            viewportWidth: document.documentElement.clientWidth,
            documentWidth: document.documentElement.scrollWidth,
            screenOverflow: active.scrollWidth > active.clientWidth,
            frameLeft: frame.left,
            frameRight: frame.right,
            frameWidth: frame.width,
            navWidth: nav.width,
            navHeight: nav.height,
            navBottom: nav.bottom,
            frameBottom: frame.bottom,
            navColumns: getComputedStyle(navList).gridTemplateColumns.split(' ').filter(Boolean).length,
            controls,
            visiblePrimary,
            launcherScreen: launcher.dataset.screen,
            launcherParent: launcher.parentElement?.className || launcher.parentElement?.id || '',
            launcherWidth: launcherRect.width,
            launcherHeight: launcherRect.height,
            overlapsLauncher,
            bodyFont: Number.parseFloat(getComputedStyle(active).fontSize),
            theme: document.documentElement.dataset.theme,
          };
        }, destination.selector);
        assert.ok(layout.documentWidth <= layout.viewportWidth,
          `${destination.selector} document overflow at ${viewport.label}/${theme}`);
        assert.equal(layout.screenOverflow, false,
          `${destination.selector} screen overflow at ${viewport.label}/${theme}`);
        assert.ok(layout.frameWidth <= 390.5,
          `${destination.selector} exceeds phone width at ${viewport.label}/${theme}`);
        assert.ok(Math.abs(layout.frameLeft - (layout.viewportWidth - layout.frameWidth) / 2) <= 1,
          `${destination.selector} is not centered at ${viewport.label}/${theme}`);
        assert.ok(layout.frameLeft >= -.5 && layout.frameRight <= layout.viewportWidth + .5);
        assert.equal(layout.navColumns, 5, `side rail at ${viewport.label}/${theme}`);
        assert.ok(layout.navWidth > layout.navHeight, `side rail at ${viewport.label}/${theme}`);
        assert.ok(Math.abs(layout.navBottom - layout.frameBottom) <= 1,
          `navigation left bottom edge at ${viewport.label}/${theme}`);
        assert.deepEqual(layout.controls.filter((control) => control.width < 44 || control.height < 44), [],
          `touch target below 44px at ${viewport.label}/${theme}`);
        assert.equal(layout.bodyFont, 16, `body type at ${viewport.label}/${theme}`);
        assert.ok(layout.visiblePrimary <= 1, `more than one solid primary at ${viewport.label}/${theme}`);
        assert.equal(layout.launcherScreen, destination.selector === '#scr10.on' ? 'scr10' : 'scr11');
        assert.match(layout.launcherParent, /paper-page-header/u,
          `Asya is not hosted by the scrolling header at ${viewport.label}/${theme}`);
        assert.ok(layout.launcherWidth >= 44 && layout.launcherHeight >= 44,
          `Asya target is undersized at ${viewport.label}/${theme}`);
        assert.deepEqual(layout.overlapsLauncher, [],
          `Asya overlaps content at ${viewport.label}/${theme}`);
        assert.equal(layout.theme, theme);
        if ([320, 390].includes(viewport.width)) {
          for (const ratio of [.5, 1]) {
            const scrolled = await page.evaluate(async ({ selector, ratio: scrollRatio }) => {
              const active = document.querySelector(selector);
              active.scrollTop = (active.scrollHeight - active.clientHeight) * scrollRatio;
              await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              const launcher = document.getElementById('asya-launcher');
              const launcherRect = launcher.getBoundingClientRect();
              const screenRect = active.getBoundingClientRect();
              const overlaps = [...active.querySelectorAll(
                '.progress-guidance article,.progress-guidance article :is(h2,p),'
                  + '[data-profile-group],[data-profile-group] :is(h2,p,strong,span,label,button)',
              )].filter((element) => {
                if (!element.getClientRects().length || launcher.hidden) return false;
                const rect = element.getBoundingClientRect();
                return rect.left < launcherRect.right && rect.right > launcherRect.left
                  && rect.top < launcherRect.bottom && rect.bottom > launcherRect.top;
              }).map((element) => element.id || element.className || element.tagName);
              return {
                scrollTop: active.scrollTop,
                launcherVisible: launcherRect.bottom > screenRect.top
                  && launcherRect.top < screenRect.bottom,
                overlaps,
              };
            }, { selector: destination.selector, ratio });
            assert.ok(scrolled.scrollTop > 0,
              `${destination.selector} did not scroll at ${viewport.label}/${theme}`);
            assert.equal(scrolled.launcherVisible, false,
              `Asya stayed in the content plane after scroll at ${viewport.label}/${theme}`);
            assert.deepEqual(scrolled.overlaps, [],
              `Asya overlaps scrolled content at ${viewport.label}/${theme}`);
          }
          await page.evaluate((selector) => { document.querySelector(selector).scrollTop = 0; }, destination.selector);
        }
      }
    }
  }

  await page.setViewportSize({ width: 320, height: 720 });
  await progressButton.click();
  await page.keyboard.press('Tab');
  const reportScroll = await page.evaluate(() => {
    const plan = document.getElementById('adaptive_plan');
    const report = document.getElementById('adaptive_report');
    const scroll = document.querySelector('.adaptive-report__scroll');
    plan.hidden = false;
    report.hidden = false;
    scroll.focus({ focusVisible: true });
    const style = getComputedStyle(scroll);
    const result = {
      active: document.activeElement === scroll,
      overflow: scroll.scrollWidth > scroll.clientWidth,
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      label: scroll.getAttribute('aria-label'),
    };
    report.hidden = true;
    plan.hidden = true;
    return result;
  });
  assert.equal(reportScroll.active, true);
  assert.equal(reportScroll.overflow, true);
  assert.notEqual(reportScroll.outlineStyle, 'none');
  assert.ok(reportScroll.outlineWidth >= 3);
  assert.match(reportScroll.label, /Таблица подробного отчёта/u);

  await navigation.getByRole('button', { name: 'Сегодня', exact: true }).click();
  await page.locator('#scr1.on').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#asya-launcher').evaluate((launcher) => launcher.parentElement?.id), 'frame',
    'Asya must return to the shell after leaving Progress/Profile');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.AisyTheme.set('dark'));
  await profileButton.click();
  await profile.getByLabel('Тёмная', { exact: true }).check();
  assert.equal(await page.evaluate(() => localStorage.getItem('aisy.theme.preference.v1')), 'dark');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 10_000 });
  assert.deepEqual(await page.evaluate(() => ({
    preference: document.documentElement.dataset.themePreference,
    theme: document.documentElement.dataset.theme,
  })), { preference: 'dark', theme: 'dark' });
  await profileButton.click();
  await page.locator('#scr11.on').waitFor({ state: 'visible' });
  assert.equal(await page.locator('input[name="profile_theme"][value="dark"]').isChecked(), true);
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await profile.getByLabel('Системная', { exact: true }).check();
  assert.deepEqual(await page.evaluate(() => ({
    preference: document.documentElement.dataset.themePreference,
    explicitTheme: document.documentElement.hasAttribute('data-theme'),
    effective: window.AisyTheme.effective,
    stored: localStorage.getItem('aisy.theme.preference.v1'),
  })), { preference: 'system', explicitTheme: false, effective: 'dark', stored: 'system' });

  await profile.locator('#privacyProfileButton').click();
  const privacy = page.locator('#privacySheet.open');
  await privacy.waitFor({ state: 'visible' });
  const darkContrast = await page.evaluate(() => {
    const link = document.querySelector('.privacyLink');
    const panel = document.querySelector('.privacyPanel');
    const secondary = document.getElementById('adaptive_upgrade');
    const revoke = document.getElementById('privacyCalibrationRevoke');
    const activeNav = document.querySelector('.aisy-shell-nav__item[aria-current="page"]');
    const iconProbe = document.createElement('span');
    iconProbe.className = 'adaptive-entry__icon';
    iconProbe.setAttribute('aria-hidden', 'true');
    panel.appendChild(iconProbe);
    revoke.hidden = false;
    const linkStyle = getComputedStyle(link);
    const panelStyle = getComputedStyle(panel);
    const secondaryStyle = getComputedStyle(secondary);
    const revokeStyle = getComputedStyle(revoke);
    const activeNavStyle = getComputedStyle(activeNav);
    const iconStyle = getComputedStyle(iconProbe);
    const result = {
      linkForeground: linkStyle.color,
      linkBackground: panelStyle.backgroundColor,
      linkHeight: link.getBoundingClientRect().height,
      secondaryForeground: secondaryStyle.color,
      secondaryBackground: secondaryStyle.backgroundColor,
      revokeHeight: revoke.getBoundingClientRect().height,
      revokeRadius: Number.parseFloat(revokeStyle.borderRadius),
      revokeFont: Number.parseFloat(revokeStyle.fontSize),
      revokeBackground: revokeStyle.backgroundColor,
      activeNavForeground: activeNavStyle.color,
      activeNavBackground: activeNavStyle.backgroundColor,
      iconForeground: iconStyle.color,
      iconBackground: iconStyle.backgroundColor,
    };
    revoke.hidden = true;
    iconProbe.remove();
    return result;
  });
  assert.ok(contrastRatio(darkContrast.linkForeground, darkContrast.linkBackground) >= 4.5,
    `dark privacy link contrast is ${contrastRatio(darkContrast.linkForeground, darkContrast.linkBackground).toFixed(2)}:1`);
  assert.ok(darkContrast.linkHeight >= 44, `privacy policy target is only ${darkContrast.linkHeight}px high`);
  assert.ok(contrastRatio(darkContrast.secondaryForeground, darkContrast.secondaryBackground) >= 4.5,
    `dark secondary action contrast is ${contrastRatio(darkContrast.secondaryForeground, darkContrast.secondaryBackground).toFixed(2)}:1`);
  assert.ok(darkContrast.revokeHeight >= 44);
  assert.ok(darkContrast.revokeRadius >= 16);
  assert.equal(darkContrast.revokeFont, 16);
  assert.notEqual(darkContrast.revokeBackground, 'rgba(0, 0, 0, 0)');
  assert.ok(contrastRatio(darkContrast.activeNavForeground, darkContrast.activeNavBackground) >= 4.5,
    `dark active-navigation contrast is ${contrastRatio(darkContrast.activeNavForeground, darkContrast.activeNavBackground).toFixed(2)}:1`);
  assert.ok(contrastRatio(darkContrast.iconForeground, darkContrast.iconBackground) >= 3,
    `dark Progress icon contrast is ${contrastRatio(darkContrast.iconForeground, darkContrast.iconBackground).toFixed(2)}:1`);
  assert.equal(await privacy.getByRole('button', { name: 'Сохранить выбор', exact: true }).count(), 1,
    'the canonical privacy CTA must expose only its visible label');
  let releasePrivacySave;
  let announcePrivacySave;
  const privacySavePaused = new Promise((resolve) => { releasePrivacySave = resolve; });
  const privacySaveRequested = new Promise((resolve) => { announcePrivacySave = resolve; });
  await page.route('**/api/v1/privacy/consent', async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.continue();
      return;
    }
    announcePrivacySave();
    await privacySavePaused;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'REQUEST_FAILED', message: 'temporary failure' } }),
    });
  });
  const privacyTextChoice = privacy.locator('#privacyText');
  const privacyTextBefore = await privacyTextChoice.isChecked();
  await privacy.locator('label.privacyChoice').first().click();
  assert.equal(await privacyTextChoice.isChecked(), !privacyTextBefore,
    'the full privacy label must toggle its checkbox');
  await privacy.getByRole('button', { name: 'Сохранить выбор', exact: true }).click();
  await privacySaveRequested;
  assert.equal(await privacy.getAttribute('aria-busy'), 'true');
  assert.equal(await privacy.locator('#privacyClose').isDisabled(), true);
  assert.equal(await privacy.locator('#privacySave').isDisabled(), true);
  await waitForFocus(page, 'privacyStatus');
  await page.keyboard.press('Escape');
  assert.equal(await privacy.isVisible(), true, 'Escape cannot imply cancellation after consent save starts');
  await page.evaluate(() => document.querySelector('.privacyBackdrop').click());
  assert.equal(await privacy.isVisible(), true, 'backdrop cannot imply cancellation after consent save starts');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.getElementById('privacySheet').contains(document.activeElement)), true);
  releasePrivacySave();
  await privacy.locator('#privacyStatus').filter({ hasText: /Внутренняя ошибка сервиса/u })
    .waitFor({ state: 'visible' });
  assert.equal(await privacy.getAttribute('aria-busy'), null);
  assert.equal(await privacy.locator('#privacyClose').isEnabled(), true);
  await waitForFocus(page, 'privacyClose');
  await page.unroute('**/api/v1/privacy/consent');
  await privacy.getByRole('button', { name: 'Позже', exact: true }).click();

  for (const standaloneCase of [
    { path: '/privacy.html', preference: 'dark', system: 'light', themeColor: '#171219' },
    { path: '/offline.html', preference: 'light', system: 'dark', themeColor: '#fff9f3' },
  ]) {
    const standalone = await context.newPage();
    await standalone.emulateMedia({ colorScheme: standaloneCase.system });
    await standalone.addInitScript((preference) => {
      try { localStorage.setItem('aisy.theme.preference.v1', preference); } catch (_) {}
    }, standaloneCase.preference);
    await standalone.goto(baseUrl + standaloneCase.path, { waitUntil: 'domcontentloaded' });
    const standaloneTheme = await standalone.evaluate(() => {
      const link = document.querySelector('.aisy-privacy-page a[href]');
      const linkStyle = link ? getComputedStyle(link) : null;
      return {
        preference: document.documentElement.dataset.themePreference,
        theme: document.documentElement.dataset.theme,
        themeColor: document.querySelector('meta[name="theme-color"]')?.content,
        background: getComputedStyle(document.body).backgroundColor,
        linkHeight: link?.getBoundingClientRect().height || 0,
        linkForeground: linkStyle?.color || '',
      };
    });
    assert.equal(standaloneTheme.preference, standaloneCase.preference);
    assert.equal(standaloneTheme.theme, standaloneCase.preference,
      `${standaloneCase.path} ignored a forced theme opposite to the OS`);
    assert.equal(standaloneTheme.themeColor, standaloneCase.themeColor);
    if (standaloneCase.path === '/privacy.html') {
      assert.ok(standaloneTheme.linkHeight >= 44,
        `standalone privacy return target is only ${standaloneTheme.linkHeight}px high`);
      assert.ok(contrastRatio(standaloneTheme.linkForeground, standaloneTheme.background) >= 4.5,
        `standalone dark privacy link contrast is ${contrastRatio(standaloneTheme.linkForeground, standaloneTheme.background).toFixed(2)}:1`);
    }
    await standalone.close();
  }
  await page.evaluate(() => window.AisyTheme.set('system'));

  await profile.locator('#profile_onboarding_restart').click();
  await page.getByRole('heading', { name: 'Каждый день — понятный шаг', exact: true }).waitFor();
  const replaySession = await context.request.get(`${baseUrl}/api/v1/me`);
  assert.equal(replaySession.status(), 200);
  assert.equal((await replaySession.json()).authenticated, true);
  await page.getByRole('button', { name: 'Далее', exact: true }).click();
  await page.getByRole('button', { name: 'Далее', exact: true }).click();
  await page.getByRole('button', { name: 'Начать', exact: true }).click();
  await page.locator('#scr11.on').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#scr5.on').count(), 0);
  assert.equal(await page.evaluate(() => window.currentUser), 'learner');

  const actionDialog = page.locator('#profile_action_dialog');
  await page.keyboard.press('Tab');
  for (const id of ['profile_known_words', 'privacyProfileButton', 'profile_logout']) {
    const focusGeometry = await profile.locator(`#${id}`).evaluate((control) => {
      control.focus({ focusVisible: true });
      const style = getComputedStyle(control);
      const surfaceRect = control.closest('.profile-group__surface').getBoundingClientRect();
      const controlRect = control.getBoundingClientRect();
      return {
        active: document.activeElement === control,
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
        insetFocus: style.boxShadow,
        contained: controlRect.left >= surfaceRect.left && controlRect.right <= surfaceRect.right,
      };
    });
    assert.equal(focusGeometry.active, true, `${id} did not receive focus`);
    assert.notEqual(focusGeometry.outlineStyle, 'none', `${id} misses a visible focus indicator`);
    assert.ok(focusGeometry.outlineWidth >= 3, `${id} focus indicator is too thin`);
    assert.notEqual(focusGeometry.insetFocus, 'none',
      `${id} needs an inset focus indicator that cannot be clipped: ${JSON.stringify(focusGeometry)}`);
    assert.equal(focusGeometry.contained, true);
  }
  const exportTrigger = profile.locator('#profile_export');
  await exportTrigger.focus();
  await exportTrigger.click();
  await actionDialog.waitFor({ state: 'visible' });
  await waitForFocus(page, 'profile_action_cancel');
  assert.equal(await actionDialog.getByRole('heading').innerText(), 'Скачать мои данные?');
  assert.equal(await actionDialog.getByRole('button', { name: 'Скачать', exact: true }).count(), 1,
    'the visual dialog affordance must not change the confirmation accessible name');
  await page.keyboard.press('Escape');
  await actionDialog.waitFor({ state: 'hidden' });
  await waitForFocus(page, 'profile_export');
  await exportTrigger.click();
  const downloadPromise = page.waitForEvent('download');
  await actionDialog.locator('#profile_action_accept').click();
  await downloadPromise;
  await actionDialog.waitFor({ state: 'hidden' });
  await waitForFocus(page, 'profile_export');
  const logoutTrigger = profile.locator('#profile_logout');
  await logoutTrigger.click();
  await waitForFocus(page, 'profile_action_cancel');
  assert.equal(await actionDialog.getByRole('button', { name: 'Выйти', exact: true }).count(), 1);
  assert.equal(await actionDialog.locator('#profile_action_cancel').isEnabled(), true);
  await page.keyboard.press('Escape');
  await actionDialog.waitFor({ state: 'hidden' });
  await waitForFocus(page, 'profile_logout');

  const deleteTrigger = profile.locator('#profile_delete');
  await deleteTrigger.click();
  await actionDialog.waitFor({ state: 'visible' });
  await waitForFocus(page, 'profile_action_phrase');
  for (let index = 0; index < 5; index += 1) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => (
      document.activeElement === document.getElementById('profile_action_dialog')
        || document.getElementById('profile_action_dialog').contains(document.activeElement)
    )), true);
  }
  await page.keyboard.press('Escape');
  await actionDialog.waitFor({ state: 'hidden' });
  await waitForFocus(page, 'profile_delete');

  await page.evaluate(() => {
    window.__ticket10EasyBoostSync = window.EasyBoostSync;
    window.EasyBoostSync = Object.freeze({
      ...window.EasyBoostSync,
      deleteOwner: async () => ({ code: 'GRAMMAR_MASTERY_QUEUE_WRITE_FAILED' }),
    });
  });
  await deleteTrigger.click();
  await actionDialog.locator('#profile_action_phrase').fill('DELETE');
  await actionDialog.locator('#profile_action_accept').click();
  const globalNotice = page.locator('#account_action_global_notice');
  await globalNotice.waitFor({ state: 'visible' });
  assert.equal(await actionDialog.isVisible(), false, 'partial cleanup warning must not stack two modal dialogs');
  assert.match(await globalNotice.locator('#account_action_global_copy').innerText(), /Аккаунт удалён на сервере/u);
  await waitForFocus(page, 'account_action_global_dismiss');
  await globalNotice.locator('#account_action_global_dismiss').click();
  await globalNotice.waitFor({ state: 'hidden' });
  await page.waitForTimeout(250);
  const postNoticeFocus = await page.evaluate(() => ({
    activeId: document.activeElement?.id || '',
    profileOn: document.getElementById('scr11')?.classList.contains('on'),
    profileInert: document.getElementById('scr11')?.inert,
    deleteDisabled: document.getElementById('profile_delete')?.disabled,
    actionOpen: document.getElementById('profile_action_dialog')?.open,
  }));
  assert.equal(postNoticeFocus.activeId, 'profile_delete', JSON.stringify(postNoticeFocus));
  await page.evaluate(() => {
    window.EasyBoostSync = window.__ticket10EasyBoostSync;
    delete window.__ticket10EasyBoostSync;
  });

  let releaseLogout;
  let announceLogout;
  const logoutPaused = new Promise((resolve) => { releaseLogout = resolve; });
  const logoutRequested = new Promise((resolve) => { announceLogout = resolve; });
  await page.route('**/api/v1/logout', async (route) => {
    announceLogout();
    await logoutPaused;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'temporary failure', code: 'REQUEST_FAILED' }),
    });
  });
  await logoutTrigger.click();
  await actionDialog.waitFor({ state: 'visible' });
  await waitForFocus(page, 'profile_action_cancel');
  await actionDialog.locator('#profile_action_accept').click();
  await logoutRequested;
  await page.locator('#profile_action_dialog[data-state="pending"]').waitFor({ state: 'visible' });
  assert.equal(await actionDialog.getAttribute('aria-busy'), 'true');
  assert.equal(await actionDialog.locator('#profile_action_cancel').isDisabled(), true);
  await waitForFocus(page, 'profile_action_status');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.getElementById('profile_action_dialog').contains(document.activeElement)), true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.getElementById('profile_action_dialog').contains(document.activeElement)), true);
  await page.keyboard.press('Escape');
  assert.equal(await actionDialog.isVisible(), true, 'Escape cannot imply cancellation after logout starts');
  releaseLogout();
  await actionDialog.locator('#profile_action_status').filter({ hasText: /Внутренняя ошибка сервиса/u })
    .waitFor({ state: 'visible' });
  assert.equal(await actionDialog.getAttribute('aria-busy'), null);
  assert.equal(await actionDialog.locator('#profile_action_cancel').isEnabled(), true);
  await waitForFocus(page, 'profile_action_cancel');
  assert.deepEqual(await page.evaluate(() => ({
    owner: window.currentUser, access: document.body.dataset.learningAccess,
  })), { owner: 'learner', access: 'active' });
  const stillActive = await context.request.get(`${baseUrl}/api/v1/me`);
  assert.equal((await stillActive.json()).authenticated, true);
  await page.keyboard.press('Escape');
  await actionDialog.waitFor({ state: 'hidden' });
  await waitForFocus(page, 'profile_logout');
  await page.unroute('**/api/v1/logout');

  await page.route(overviewPattern, (route) => route.abort('internetdisconnected'));
  await progressButton.click();
  await page.locator('#scr10.on #progress_guidance[data-state="offline"][aria-busy="false"]')
    .waitFor({ state: 'visible', timeout: 10_000 });
  assert.match(await page.locator('#progress_state_label').innerText(), /Офлайн.*сохранённая сводка/iu);
  await page.unroute(overviewPattern);

  await profileButton.click();
  await page.evaluate(() => Object.keys(localStorage)
    .filter((key) => key.startsWith('easyboost.adaptive.overview.v1'))
    .forEach((key) => localStorage.removeItem(key)));
  await page.route(overviewPattern, (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: 'temporary failure', code: 'REQUEST_FAILED' }),
  }));
  await progressButton.click();
  try {
    await page.locator('#scr10.on #progress_guidance[data-state="error"][aria-busy="false"]')
      .waitFor({ state: 'visible', timeout: 10_000 });
  } catch (error) {
    const state = await page.evaluate(() => ({
      screen: document.getElementById('scr10')?.className,
      state: document.getElementById('progress_guidance')?.dataset.state,
      source: document.getElementById('progress_guidance')?.dataset.source,
      busy: document.getElementById('progress_guidance')?.getAttribute('aria-busy'),
      label: document.getElementById('progress_state_label')?.textContent,
      cacheKeys: Object.keys(localStorage).filter((key) => key.startsWith('easyboost.adaptive.overview.v1')),
      owner: window.currentUser,
    }));
    throw new Error(`Progress error state did not settle: ${JSON.stringify(state)}; console=${consoleErrors.join(' | ')}; page=${pageErrors.join(' | ')}`, { cause: error });
  }
  assert.match(await page.locator('#progress_state_label').innerText(), /Ошибка.*недоступна/iu);
  await page.unroute(overviewPattern);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 10_000 });
  await page.route('**/api/v1/me', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'REQUEST_FAILED', message: 'temporary failure' } }),
  }));
  await profileButton.click();
  await page.locator('#access_gate[data-state="network-unknown"]')
    .waitFor({ state: 'visible', timeout: 10_000 });
  assert.match(await page.locator('#pf_plan_name').innerText(), /Не удалось проверить доступ/u);
  assert.match(await page.locator('#pf_voice_detail').innerText(), /Статус временно недоступен/u);
  assert.equal(await page.locator('#pf_voice_action').isHidden(), true);
  assert.equal(await page.evaluate(() => window.currentUser), 'learner',
    'a retryable Profile refresh failure must not misrepresent itself as logout');
  await page.unroute('**/api/v1/me');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 10_000 });
  await page.route('**/api/v1/me', (route) => route.fulfill({
    status: 200,
    headers: { 'X-EasyBoost-Response-Owner': 'learner', 'Cache-Control': 'no-store' },
    contentType: 'application/json',
    body: JSON.stringify({
      authenticated: true,
      username: 'learner',
      displayName: 'Learner',
      role: 'student',
      active: false,
      sub_until: Date.now() - 86_400_000,
      entitlements: { voice_tutor: false },
      voice_tutor: {},
      features: { adaptive_learning: false },
    }),
  }));
  await profileButton.click();
  await page.locator('#access_gate[data-state="inactive"]')
    .waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(await page.locator('#access_gate_title').innerText(), 'Нужен активный доступ');
  assert.equal(await page.locator('#access_gate_privacy').isVisible(), true,
    'an expired learner keeps signed-in access to privacy controls');
  assert.equal(await page.evaluate(() => window.currentUser), 'learner',
    'expiry must gate the learner shell without logging out identity');
  await page.unroute('**/api/v1/me');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('#scr1.on').waitFor({ state: 'visible', timeout: 10_000 });
  await page.route('**/api/v1/me', (route) => route.fulfill({
    status: 401,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'session expired' } }),
  }));
  await profileButton.click();
  await page.waitForFunction(() => window.currentUser == null);
  await page.locator('#scr5.on').waitFor({ state: 'visible', timeout: 10_000 });
  assert.equal(await page.evaluate(() => window.__sub), null,
    'an authoritative Profile session failure must clear stale private session data');
  await page.unroute('**/api/v1/me');

  assert.deepEqual(pageErrors, [], 'Progress/Profile must not emit page errors');
  const unexpectedConsoleErrors = consoleErrors.filter((message) => (
    !/Failed to load resource|ERR_INTERNET_DISCONNECTED|status of 503/iu.test(message)
  ));
  assert.deepEqual(unexpectedConsoleErrors, [], 'Progress/Profile must not emit unexpected console errors');
  await context.close();
  console.log('Aisy Paper A Progress/Profile Chromium E2E passed.');
} finally {
  if (browser) await browser.close();
  await stopProcess(child);
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
