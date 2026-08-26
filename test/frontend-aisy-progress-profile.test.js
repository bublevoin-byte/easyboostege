import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import {
  presentCommercialError,
  presentProfilePlan,
  presentPublicPlan,
} from '../public/commercial-copy.js';
import * as commercialCopy from '../public/commercial-copy.js';

const progressSource = await fs.readFile(new URL('../public/modules/progress.js', import.meta.url), 'utf8');

function createProgressModule() {
  const window = {};
  vm.runInNewContext(progressSource, { window, Object, Number, Math, Array, String, Boolean, Date, Map, Set });
  return window.EasyBoostProgress;
}

test('public plan presentation keeps internal tiers out of strict active-access copy', () => {
  const presentation = presentPublicPlan({
    tier: 'base',
    capabilities: {
      continuousPlan: true,
      deepDiagnostic: false,
      detailedReports: false,
    },
  });

  assert.deepEqual(presentation, {
    id: 'active',
    label: 'Активный доступ',
    summary: 'Персональный план доступен. Глубокая диагностика и подробные отчёты не входят в текущий доступ.',
    capabilities: [
      { id: 'personal-plan', label: 'Персональный план', available: true },
      { id: 'deep-diagnostic', label: 'Глубокая диагностика', available: false },
      { id: 'detailed-reports', label: 'Подробные отчёты', available: false },
    ],
  });
  assert.doesNotMatch(JSON.stringify(presentation), /Base|Free|Premium|демо/iu);
});

test('progress narrative leads with a private aggregate next action and separates evidence quality', () => {
  const progress = createProgressModule();
  const narrative = progress.narrative({
    profile: {
      needsDiagnostic: false,
      evidenceCount: 8,
      independentEvidenceCount: 5,
      assistedEvidenceCount: 2,
      clientReportedEvidenceCount: 1,
      modules: [
        { id: 'grammar', mastery: 45, uncertainty: 72, status: 'preliminary', evidenceCount: 3 },
        { id: 'reading', mastery: 78, uncertainty: 25, status: 'established', evidenceCount: 5 },
      ],
    },
    retention: {
      next_best_review: {
        skill_label: 'Past Simple',
        prompt: 'private prompt must not leak',
        learnerAnswer: 'private answer must not leak',
      },
    },
  });

  assert.equal(narrative.next.kind, 'review');
  assert.equal(narrative.next.title, 'Повторить Past Simple');
  assert.match(narrative.improved.text, /Чтение.*78%/u);
  assert.match(narrative.needsWork.text, /Грамматика/u);
  assert.deepEqual(JSON.parse(JSON.stringify(
    narrative.evidence.map(({ id, count }) => ({ id, count })),
  )), [
    { id: 'independent', count: 5 },
    { id: 'assisted', count: 2 },
    { id: 'approximate', count: 1 },
  ]);
  const publicCopy = JSON.stringify(narrative);
  assert.doesNotMatch(publicCopy, /private prompt|private answer|IELTS/u);
  assert.match(publicCopy, /если используется, экспериментальна.*не является официальным результатом ЕГЭ/u);
});

test('profile and adaptive errors expose strict access and an honest operator next step', () => {
  assert.deepEqual(presentProfilePlan({
    active: true,
    entitlements: { voice_tutor: false },
  }), {
    id: 'active',
    label: 'Активный доступ',
    summary: 'Основной учебный доступ активен. Голосовой разбор Аси не входит в текущий доступ.',
    voiceTutorAvailable: false,
  });
  assert.deepEqual(presentProfilePlan(null), {
    id: 'inactive',
    label: 'Доступ не активирован',
    summary: 'Обратитесь к оператору, который выдал доступ.',
    voiceTutorAvailable: false,
  });
  assert.equal(
    presentCommercialError({ code: 'ADAPTIVE_BASE_REQUIRED' }),
    'Текущего доступа недостаточно. Обратитесь к оператору, который выдал доступ.',
  );
  assert.doesNotMatch([
    presentCommercialError({ code: 'ADAPTIVE_BASE_REQUIRED' }),
    presentCommercialError({ code: 'ADAPTIVE_FREE_DIAGNOSTIC_USED' }),
  ].join(' '), /Base|Free|Premium|демо|checkout/iu);
});

test('versioned legacy disclaimers are presented with the current public brand', () => {
  assert.equal(
    commercialCopy.presentPublicBrand('Ориентировочный прогноз Easy Boost, а не официальный результат ЕГЭ.'),
    'Ориентировочный прогноз Aisy.space, а не официальный результат ЕГЭ.',
  );
});

test('Progress and Profile expose the approved learner information hierarchy without private or future-role controls', async () => {
  const [markup, progressScreen, profileScreen, privacy, styles] = await Promise.all([
    fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/screens/progress.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/screens/profile.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/privacy.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/progress-profile.css', import.meta.url), 'utf8'),
  ]);

  assert.match(markup, /href="\/progress-profile\.css"/u);
  const progressMarkup = markup.slice(markup.indexOf('id="scr10"'), markup.indexOf('id="scr11"'));
  assert.ok(progressMarkup.indexOf('id="progress_next_action"') < progressMarkup.indexOf('id="p_streak"'));
  for (const id of [
    'progress_next_title', 'progress_next_copy', 'progress_next_action',
    'progress_improved_copy', 'progress_needs_work_copy', 'progress_evidence_legend',
  ]) assert.match(progressMarkup, new RegExp(`id="${id}"`, 'u'));
  assert.equal((progressMarkup.match(/\b(?:aisy-button|adaptive-action--primary)\b/gu) || []).length, 1);
  assert.doesNotMatch(progressMarkup, /id="adaptive_session_start"[^>]*style="[^"]*background:/u);
  assert.match(progressScreen, /progressModule\.narrative\(payload\)/u);
  assert.match(progressScreen, /function drawProgressNarrative/u);
  assert.match(progressScreen, /presentPublicBrand\(EGE_MOCK_FORECAST_METADATA\.disclaimer\)/u);
  assert.match(progressScreen, /navigateTopLevel\('aisy-practice'\)/u);
  assert.doesNotMatch(progressMarkup, />[^<]*Base[^<]*</u);
  assert.doesNotMatch(progressMarkup, />[^<]*(?:Free|демо|checkout|без оплаты)[^<]*</iu);
  assert.doesNotMatch(progressMarkup, />[^<]*IELTS[^<]*</u);
  assert.doesNotMatch(progressScreen, /['"`][^'"`]*Base[^'"`]*['"`]/u);
  assert.doesNotMatch(progressScreen, /['"`][^'"`]*IELTS[^'"`]*['"`]/u);

  const profileMarkup = markup.slice(markup.indexOf('id="scr11"'), markup.indexOf('id="scr16"'));
  assert.match(profileMarkup, /<h1[^>]*id="profile_page_title"[^>]*>Профиль<\/h1>/u);
  for (const group of ['study', 'asya-privacy', 'subscription', 'account-data']) {
    assert.match(profileMarkup, new RegExp(`data-profile-group="${group}"`, 'u'));
  }
  assert.equal((progressMarkup.match(/\baisy-surface\b/gu) || []).length, 4);
  assert.ok((profileMarkup.match(/\baisy-surface\b/gu) || []).length >= 4);
  assert.doesNotMatch(styles, /@media\s*\(prefers-reduced-motion/u);
  assert.doesNotMatch(styles, /font(?:-size)?:[^;]*14px/u);
  assert.match(profileMarkup, /id="pf_plan_name"/u);
  assert.match(profileMarkup, /id="pf_plan_summary"/u);
  assert.match(profileMarkup, /id="profile_privacy_actions"/u);
  assert.match(profileMarkup, /id="profile_data_actions"/u);
  assert.match(profileMarkup, /Ася[^<]*микрофон|микрофон[^<]*Ася/iu);
  assert.doesNotMatch(profileMarkup, /родител|преподавател|учител/iu);
  assert.doesNotMatch(profileMarkup, />[^<]*Base[^<]*</u);
  assert.doesNotMatch(profileMarkup, />[^<]*(?:Free|демо|checkout|без оплаты)[^<]*</iu);
  assert.doesNotMatch(progressScreen, /['"`][^'"`]*(?:Free-демо|бесплатное пробное|нужен Premium)[^'"`]*['"`]/iu);
  assert.match(profileScreen, /presentProfilePlan/u);
  assert.match(privacy, /getElementById\('profile_privacy_actions'\)/u);
  assert.match(privacy, /getElementById\('profile_data_actions'\)/u);
});

test('legacy compatibility never leaks old brand or a public Base tier into learner copy', async () => {
  const [progressModuleSource, speakingScreen, profileModuleSource, appSource] = await Promise.all([
    fs.readFile(new URL('../public/modules/progress.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/screens/speaking.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/modules/profile.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(progressModuleSource, /Оценка Easy Boost/u);
  assert.match(progressModuleSource, /Оценка Aisy\.space/u);
  assert.doesNotMatch(speakingScreen, /['"](?:Base|BASE)['"]/u);
  assert.match(speakingScreen, /presentPublicPlan/u);
  assert.match(profileModuleSource, /Голосовой разбор Аси/u);
  assert.match(profileModuleSource, /Не входит в текущий доступ/u);
  assert.doesNotMatch(profileModuleSource, /Запросить Premium|Voice Tutor · Premium/u);
  assert.match(appSource, /product:'premium_voice'/u);
});

test('Progress and Profile presentation assets stay in the eager offline and security closure', async () => {
  const [worker, security] = await Promise.all([
    fs.readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('./security-regression.test.js', import.meta.url), 'utf8'),
  ]);
  for (const path of ['/commercial-copy.js', '/progress-profile.css']) {
    assert.match(worker, new RegExp(`'${path.replaceAll('/', '\\/')}'`, 'u'));
  }
  assert.match(security, /'commercial-copy\.js'/u);
});

test('profile hooks observe rejected lazy controls without delaying synchronous hooks', async () => {
  const [appSource, privacyLoaderSource] = await Promise.all([
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/privacy-loader.js', import.meta.url), 'utf8'),
  ]);
  assert.match(appSource, /Promise\.resolve\(hook\(\)\)\.catch/u);
  assert.doesNotMatch(appSource, /forEach\(function\(hook\)\{try\{hook\(\)\}/u);
  assert.match(privacyLoaderSource, /registerProfileHook\(async function/u);
});
