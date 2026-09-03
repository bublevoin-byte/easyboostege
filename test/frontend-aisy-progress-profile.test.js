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

  assert.deepEqual(presentPublicPlan({
    tier: 'free',
    capabilities: { continuousPlan: true, deepDiagnostic: true, detailedReports: true },
  }), {
    id: 'inactive',
    label: 'Доступ не активирован',
    summary: 'Обратитесь к оператору, который выдал доступ.',
    capabilities: [
      { id: 'personal-plan', label: 'Персональный план', available: false },
      { id: 'deep-diagnostic', label: 'Глубокая диагностика', available: false },
      { id: 'detailed-reports', label: 'Подробные отчёты', available: false },
    ],
  });
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
  assert.equal(narrative.change.comparable, false);
  assert.match(narrative.change.text, /сравнени/iu);
  assert.doesNotMatch(narrative.change.text, /улучшил|рост/u);
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

test('progress outcome change is comparative and never labels a strongest snapshot as growth', () => {
  const progress = createProgressModule();
  const current = {
    profile: {
      evidenceFingerprint: 'current',
      independentEvidenceCount: 7,
      modules: [
        { id: 'grammar', mastery: 58, status: 'established', evidenceCount: 4, independentEvidenceCount: 4 },
        { id: 'reading', mastery: 72, status: 'established', evidenceCount: 3, independentEvidenceCount: 3 },
      ],
    },
  };
  const previousProfile = {
    evidenceFingerprint: 'previous',
    independentEvidenceCount: 5,
    modules: [
      { id: 'grammar', mastery: 45, status: 'established', evidenceCount: 3, independentEvidenceCount: 3 },
      { id: 'reading', mastery: 76, status: 'established', evidenceCount: 2, independentEvidenceCount: 2 },
    ],
  };

  const comparison = progress.narrative(current, { previousProfile });
  assert.equal(comparison.change.comparable, true);
  assert.equal(comparison.change.direction, 'up');
  assert.match(comparison.change.text, /Грамматика.*\+13 п\.\s?п\./u);
  assert.match(comparison.change.detail, /двум сопоставимым сохранённым срезам/u);

  const noBaseline = progress.narrative(current);
  assert.equal(noBaseline.change.comparable, false);
  assert.match(noBaseline.change.text, /сравнени/iu);
  assert.doesNotMatch(noBaseline.change.text, /улучшил|рост/u);

  const assistedOnlyChange = progress.narrative({
    profile: {
      ...current.profile,
      evidenceFingerprint: 'assisted-only',
      independentEvidenceCount: previousProfile.independentEvidenceCount,
    },
  }, { previousProfile });
  assert.equal(assistedOnlyChange.change.comparable, false);

  const materialDecline = progress.narrative({
    profile: {
      evidenceFingerprint: 'next', independentEvidenceCount: 8,
      modules: [
        { id: 'grammar', mastery: 46, evidenceCount: 4, independentEvidenceCount: 4 },
        { id: 'reading', mastery: 56, evidenceCount: 4, independentEvidenceCount: 4 },
      ],
    },
  }, { previousProfile });
  assert.equal(materialDecline.change.direction, 'down');
  assert.match(materialDecline.change.text, /Чтение.*-20 п\.\s?п\./u);
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
  assert.deepEqual(presentProfilePlan({
    active: false,
    entitlements: { voice_tutor: true },
  }), {
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

test('limited Progress access locks the composer and never promises a public demo session', async () => {
  const screen = await fs.readFile(new URL('../public/screens/progress.js', import.meta.url), 'utf8');
  assert.match(screen, /const limited=access\.tier==='free'/u);
  assert.match(screen, /input\.disabled=limited/u);
  assert.match(screen, /if\(preview\)preview\.disabled=limited/u);
  assert.match(screen, /if\(paywall\)paywall\.hidden=!limited/u);
  assert.match(screen, /access\.tier==='free'\|\|!\(access\.capabilities&&access\.capabilities\.shortDiagnostic\)/u);
  assert.doesNotMatch(screen, /Сейчас доступно занятие на 15 минут/u);
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
  assert.ok(progressMarkup.indexOf('id="progress_change_card"') < progressMarkup.indexOf('id="progress_weak_card"'));
  assert.ok(progressMarkup.indexOf('id="progress_weak_card"') < progressMarkup.indexOf('id="progress_next_card"'));
  assert.ok(progressMarkup.indexOf('id="progress_next_action"') < progressMarkup.indexOf('id="p_streak"'));
  for (const id of [
    'progress_next_title', 'progress_next_copy', 'progress_next_action',
    'progress_improved_copy', 'progress_needs_work_copy', 'progress_evidence_legend',
  ]) assert.match(progressMarkup, new RegExp(`id="${id}"`, 'u'));
  assert.equal((progressMarkup.match(/\b(?:aisy-button|adaptive-action--primary)\b/gu) || []).length, 1);
  assert.doesNotMatch(progressMarkup, /id="adaptive_session_start"[^>]*style="[^"]*background:/u);
  assert.match(progressScreen, /progressModule\.narrative\(payload,\{previousProfile:previousProfile\}\)/u);
  assert.match(progressScreen, /function drawProgressNarrative/u);
  assert.match(progressScreen, /function markProgressLoading/u);
  assert.match(progressScreen, /presentPublicBrand\(EGE_MOCK_FORECAST_METADATA\.disclaimer\)/u);
  assert.match(progressScreen, /navigateTopLevel\('aisy-practice'\)/u);
  assert.doesNotMatch(progressMarkup, />[^<]*Base[^<]*</u);
  assert.doesNotMatch(progressMarkup, />[^<]*(?:Free|демо|checkout|без оплаты)[^<]*</iu);
  assert.doesNotMatch(progressMarkup, />[^<]*IELTS[^<]*</u);
  assert.doesNotMatch(progressScreen, /['"`][^'"`]*Base[^'"`]*['"`]/u);
  assert.doesNotMatch(progressScreen, /['"`][^'"`]*IELTS[^'"`]*['"`]/u);
  assert.match(progressMarkup, /id="progress_guidance"[^>]*aria-label="Главная сводка прогресса"[^>]*aria-busy="true"/u);
  assert.doesNotMatch(progressMarkup, /id="progress_guidance"[^>]*aria-labelledby="progress_next_heading"/u);
  assert.doesNotMatch(progressMarkup, /id="progress_guidance"[^>]*aria-live/u);
  assert.doesNotMatch(progressMarkup, /id="adaptive_plan"[^>]*aria-live/u);
  assert.match(progressMarkup, /id="progress_state_label"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/u);
  assert.doesNotMatch(progressMarkup + progressScreen, /🔥/u);
  assert.doesNotMatch(progressMarkup, /\sonclick=/u);
  assert.match(progressMarkup, /class="adaptive-report__scroll"[^>]*role="region"[^>]*aria-label="[^"]+"[^>]*tabindex="0"/u);

  const profileMarkup = markup.slice(markup.indexOf('id="scr11"'), markup.indexOf('id="scr16"'));
  assert.match(profileMarkup, /<h1[^>]*id="profile_page_title"[^>]*>Профиль<\/h1>/u);
  for (const group of ['identity', 'preferences', 'access', 'privacy', 'account-data']) {
    assert.match(profileMarkup, new RegExp(`data-profile-group="${group}"`, 'u'));
  }
  const groupOrder = ['identity', 'preferences', 'access', 'privacy', 'account-data']
    .map((group) => profileMarkup.indexOf(`data-profile-group="${group}"`));
  assert.deepEqual(groupOrder, [...groupOrder].sort((first, second) => first - second));
  const accessMarkup = profileMarkup.slice(groupOrder[2], groupOrder[3]);
  const privacyMarkup = profileMarkup.slice(groupOrder[3], groupOrder[4]);
  assert.match(accessMarkup, /id="pf_voice_row"/u);
  assert.doesNotMatch(accessMarkup, /id="pf_voice_detail"[^>]*role="status"/u);
  assert.doesNotMatch(privacyMarkup, /id="pf_voice_row"/u);
  assert.equal((progressMarkup.match(/\baisy-surface\b/gu) || []).length, 4);
  assert.ok((profileMarkup.match(/\baisy-surface\b/gu) || []).length >= 4);
  assert.doesNotMatch(styles, /@media\s*\(prefers-reduced-motion/u);
  assert.doesNotMatch(styles, /font(?:-size)?:[^;]*14px/u);
  assert.match(profileMarkup, /id="pf_plan_name"/u);
  assert.match(profileMarkup, /id="pf_plan_summary"/u);
  assert.match(profileMarkup, /id="profile_privacy_actions"/u);
  assert.match(profileMarkup, /id="profile_data_actions"/u);
  assert.match(profileMarkup, /id="profile_theme_preferences"/u);
  for (const theme of ['system', 'light', 'dark']) {
    assert.match(profileMarkup, new RegExp(`name="profile_theme"[^>]*value="${theme}"`, 'u'));
  }
  assert.match(profileMarkup, /id="profile_action_dialog"[^>]*aria-modal="true"/u);
  assert.match(profileMarkup, /id="profile_export"/u);
  assert.match(profileMarkup, /id="profile_delete"/u);
  assert.match(profileMarkup, /id="profile_logout"/u);
  assert.equal((profileMarkup.match(/id="profile_onboarding_restart"/gu) || []).length, 1);
  assert.doesNotMatch(progressMarkup, /\sstyle=/u);
  assert.doesNotMatch(profileMarkup, /\sstyle=/u);
  assert.doesNotMatch(progressMarkup + profileMarkup, /#[0-9a-f]{3,8}|gradient\(/iu);
  assert.match(profileMarkup, /Ася[^<]*микрофон|микрофон[^<]*Ася/iu);
  assert.doesNotMatch(profileMarkup, /родител|преподавател|учител/iu);
  assert.doesNotMatch(profileMarkup, />[^<]*Base[^<]*</u);
  assert.doesNotMatch(profileMarkup, />[^<]*(?:Free|демо|checkout|без оплаты)[^<]*</iu);
  assert.doesNotMatch(progressScreen, /['"`][^'"`]*(?:Free-демо|бесплатное пробное|нужен Premium)[^'"`]*['"`]/iu);
  assert.match(profileScreen, /presentProfilePlan/u);
  assert.match(profileScreen, /title: 'Скачать мои данные\?'/u);
  assert.match(profileScreen, /profileActionAuthority = Object\.freeze\(\{ \.\.\.authority \}\)/u);
  assert.match(profileScreen, /const authority = profileActionAuthority[\s\S]*?if \(!profileAuthorityCurrent\(authority\)\)/u);
  assert.match(profileScreen, /function profileOperationCurrent\(operation, action, authority\)/u);
  assert.match(profileScreen, /definition\.confirmPhrase \? phrase : cancel/u);
  assert.match(profileScreen, /function profileActionControls/u);
  assert.match(profileScreen, /event\.key !== 'Tab'/u);
  assert.match(profileScreen, /GRAMMAR_MASTERY_QUEUE_WRITE_FAILED[\s\S]*?Аккаунт удалён на сервере/u);
  assert.match(profileScreen, /profileActionPending = Boolean\(pending\)[\s\S]*?cancel\.disabled = profileActionPending/u);
  assert.match(profileScreen, /if \(profileActionPending\) return;/u);
  assert.match(profileScreen, /showAccountGlobalNoticeWhenSafe\(warning\)/u);
  assert.match(profileScreen, /closeProfileAction\(\{ force: true \}\)[\s\S]*?showAccountGlobalNoticeWhenSafe\(warning\)/u);
  assert.match(markup, /id="account_action_global_notice"[^>]*role="alertdialog"/u);
  assert.match(profileScreen, /AisyTheme\.set/u);
  assert.match(profileScreen, /showModal\(\)/u);
  assert.match(profileScreen, /EasyBoostSync\?\.deleteOwner/u);
  assert.match(profileScreen, /const authority = profileActionAuthority[\s\S]*?await logout\(authority\)/u);
  assert.doesNotMatch(profileScreen, /\b(?:confirm|prompt|alert)\s*\(/u);
  assert.match(privacy, /getElementById\('profile_privacy_actions'\)/u);
  assert.doesNotMatch(privacy, /\b(?:confirm|prompt|alert)\s*\(/u);
  assert.doesNotMatch(privacy, /setAttribute\(['"]style|\.style\./u);
  assert.match(privacy, /privacyAuthorityCurrent\(authority\)/u);
  assert.match(privacy, /registerAuthorityReset/u);
  assert.match(privacy, /operation === privacyOperation && privacyAuthorityCurrent\(authority\)/u);
  assert.match(privacy, /privacyPending = Boolean\(pending\)[\s\S]*?sheet\.setAttribute\('aria-busy', 'true'\)/u);
  assert.match(privacy, /if \(privacyPending && !force\) return false/u);
  assert.match(privacy, /event\.key === 'Escape'[\s\S]*?!privacyPending/u);
  assert.match(privacy, /id="privacyCalibrationRevoke" class="privacyBtn privacyDangerAction"/u);
  assert.match(styles, /\.privacyDangerAction\s*\{/u);
  assert.match(styles, /\.adaptive-duration-grid label:has\(input:focus-visible\)/u);
  assert.match(styles, /\.profile-theme-choice:has\(input:focus-visible\)/u);
  assert.match(styles, /\.privacyChoice:has\(input:focus-visible\)/u);
  assert.match(styles, /\.privacyLink\s*\{[^}]*color:\s*var\(--aisy-color-selection\)/su);
  assert.match(styles, /\.adaptive-action--secondary\s*\{[^}]*?\n\s*color:\s*var\(--aisy-color-text-strong\);/su);
});

test('profile theme and account actions use semantic state without raw presentation values', async () => {
  const [profileScreen, profileModuleSource, appSource, privacySource, styles] = await Promise.all([
    fs.readFile(new URL('../public/screens/profile.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/modules/profile.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/privacy.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/progress-profile.css', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(profileModuleSource, /#[0-9a-f]{3,8}/iu);
  assert.doesNotMatch(profileModuleSource, /\b(?:color|background):/u);
  assert.doesNotMatch(profileScreen, /setAttribute\(['"]style|\.style\./u);
  assert.doesNotMatch(privacySource, /document\.createElement\(['"]style['"]\)/u);
  assert.doesNotMatch(appSource.slice(
    appSource.indexOf('/* статус подписки в профиле */'),
    appSource.indexOf('/* legacy block 5 */'),
  ), /setAttribute\(['"]style|\.style\.|#[0-9a-f]{3,8}/iu);
  const profileStatusHook = appSource.slice(
    appSource.indexOf('/* статус подписки в профиле */'),
    appSource.indexOf('/* legacy block 5 */'),
  );
  assert.match(profileStatusHook, /profileOwner=currentUser/u);
  assert.match(profileStatusHook, /ownerBoundGeneration\?\.\(profileOwner\)/u);
  assert.match(profileStatusHook, /return Promise\.all\(\[me\(\{headers:ownerHeaders,cache:'no-store'\}\)/u);
  assert.match(profileStatusHook, /sessionMatchesOwner\(profile,profileOwner\)[\s\S]*?apiResponseOwner\(profile\)!==profileOwner/u);
  assert.match(profileStatusHook, /window\.__sub=profile/u);
  assert.match(profileStatusHook, /profile\.active!==true[\s\S]*?applyLearningAccess\(classifyLearningAccess\(profile\)\)/u);
  assert.match(profileStatusHook, /requestResult\.error[\s\S]*?paymentUnknown:true/u);
  assert.match(profileStatusHook, /\.catch\(async function\(error\)[\s\S]*?apiIsAuthorityFailure\(error\)[\s\S]*?invalidateLearningAuthority\(profileAuthority\)/u);
  assert.match(profileStatusHook, /renderProfileUnknown\([^)]*\)[\s\S]*?LEARNING_ACCESS_STATES\.NETWORK_UNKNOWN/u);
  assert.match(styles, /\.profile-theme-choice/u);
  assert.match(styles, /\.profile-action-dialog/u);
  assert.match(styles, /\[data-state="(?:active|inactive|pending|danger)"\]/u);
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

test('profile hooks and consent probes stay owner-bound without delaying synchronous hooks', async () => {
  const [appSource, privacyLoaderSource, speakingSource] = await Promise.all([
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/privacy-loader.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/screens/speaking.js', import.meta.url), 'utf8'),
  ]);
  assert.match(appSource, /Promise\.resolve\(hook\(\)\)\.catch/u);
  assert.doesNotMatch(appSource, /forEach\(function\(hook\)\{try\{hook\(\)\}/u);
  assert.match(privacyLoaderSource, /registerProfileHook\(async function/u);
  assert.match(privacyLoaderSource, /X-EasyBoost-Expected-Owner/u);
  assert.match(privacyLoaderSource, /apiResponseOwner\(current\)!==authority\.owner/u);
  assert.match(privacyLoaderSource, /invalidateLearningAuthority\(authority\)/u);
  assert.match(speakingSource, /apiGet\('\/api\/v1\/speaking\/calibration-consent',consentOptions\)/u);
  assert.match(speakingSource, /apiPut\('\/api\/v1\/speaking\/calibration-consent',[\s\S]*?spOwnerHeaders\(authority\)/u);
  assert.match(speakingSource, /apiResponseOwner\(consent\)!==authority\.owner/u);
  assert.match(speakingSource, /apiIsAuthorityFailure\(error\)[\s\S]*?invalidateLearningAuthority\(authority\)/u);
});
