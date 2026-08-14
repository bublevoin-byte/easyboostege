import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const [markup, screen, entry, screenLoader, worker, app, sync, router, runnerSource, performanceSource, performanceBaseline] = await Promise.all([
  fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/screens/ege-mock.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/main.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/screens.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/sync.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/router.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/ege-mock-written-runner.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../e2e/performance.test.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../docs/PERFORMANCE_BASELINE.md', import.meta.url), 'utf8'),
]);

test('written mock exposes one accessible responsive runner without score or key controls', () => {
  assert.match(markup, /data-ege-mock-root/u);
  assert.match(markup, /role="timer"/u);
  assert.match(markup, /\.ege-mock button,[^{]*\.ege-mock input,[^{]*\.ege-mock select\{min-height:44px\}/u);
  assert.match(markup, /\.ege-mock\{[^}]*overflow-x:hidden/u);
  assert.match(markup, /@media\(prefers-reduced-motion:reduce\)\{\.ege-mock \*\{/u);
  assert.match(screen, /Array\.from\(\{ length: 36 \}/u);
  assert.match(screen, /blankPositions/u);
  assert.match(screen, /currentEgeMockOwnerBinding/u);
  assert.match(screen, /apiResponseOwner\(result\) !== owner\.username/u);
  assert.match(screen, /apiResponseServerTime/u);
  assert.match(screen, /'Idempotency-Key': input\.idempotencyKey/u);
  assert.match(screen, /type: 'completeObjective'/u);
  assert.match(screen, /apiIsAuthorityFailure/u);
  assert.match(screen, /invalidateLearningAuthority/u);
  assert.match(screen, /refreshRunningProjection/u);
  assert.match(screen, /type: 'audioStart'/u);
  assert.match(screen, /type: 'audioFinish'/u);
  assert.match(screen, /audioInFlight/u);
  assert.match(screen, /snapshot\.phase === before/u);
  assert.match(screen, /navigator\.onLine && retryQueued && Date\.now\(\) >= retryAt/u);
  assert.match(screen, /apiGet\(`\/api\/v1\/ege-mocks\/attempts\/\$\{attemptId\}`/u);
  assert.match(screen, /before\.phase === 'asset_blocked' \? 'restore' : 'sync'/u);
  assert.match(screen, /Exact-кэш этой формы недоступен/u);
  assert.doesNotMatch(screen, /written\/submit/u);
  assert.doesNotMatch(screen, /answerKey|correctAnswer|showHint|showScore/u);
  assert.doesNotMatch(runnerSource, /writerId/u);
});

test('the EGE runner stays lazy while an opened exact attempt remains runtime-cache restorable', () => {
  assert.doesNotMatch(performanceSource, /const SHELL_SCREENS = \[[^\]]*'screens\/ege-mock\.js'/u);
  assert.match(performanceSource, /const LAZY_SCREENS = \[[^\]]*'screens\/ege-mock\.js'/u);
  assert.doesNotMatch(entry, /import \* as egeMockScreen from/u);
  assert.match(performanceBaseline, /ленивых экранов \([^)]*`ege-mock`/u);
});

test('the written runner and exact revision caches are reachable after an app reload', () => {
  assert.match(screenLoader, /scr16:function\(\)\{return import\('\.\/screens\/ege-mock\.js'\)\}/u);
  assert.match(worker, /easyboost-ege-mock-assets-v1-/u);
  assert.match(worker, /ege-mock-form-1-v1\.js/u);
  assert.match(worker, /!key\.startsWith\('easyboost-ege-mock-assets-v1-'\)/u);
  assert.match(worker, /matchEgeMockAsset\(url,requestedCache,rangeHeader\(request\)\)/u);
  assert.match(worker, /searchParams\.get\('egeMockAssetCache'\)/u);
  assert.match(worker, /caches\.open\(requestedCache\)/u);
  const exactAssetMatcher = worker.slice(
    worker.indexOf('async function matchEgeMockAsset'), worker.indexOf('const EGE_MOCK_FORM_CACHE'),
  );
  assert.doesNotMatch(exactAssetMatcher, /for\(const name of names\)/u);
  assert.doesNotMatch(worker, /\/api\/v1\/ege-mocks[^\n]*cache/u);
  assert.match(app, /offlineEgeMockContinuation\(\)/u);
  assert.match(app, /offlineEgeMock:true/u);
  assert.match(app, /tab\('scr16'\)/u);
  assert.match(screen, /listeningModule\.registerPlay\(plays, group, 2\)/u);
  assert.match(screen, /normalizeEgeMockSelection/u);
  assert.match(screen, /type: 'refreshLocal'/u);
  assert.doesNotMatch(screen, /<audio controls/u);
});

test('same-phase synchronization and exact-owner storage merges refresh status without replacing focus', () => {
  assert.match(screen, /function refreshRunningProjection\(/u);
  assert.match(screen, /snapshot\.phase === before[\s\S]*?refreshRunningProjection\(snapshot\)/u);
  assert.match(screen, /event\.key === runnerStorageKey/u);
  assert.match(screen, /document\.activeElement/u);
  assert.match(screen, /refreshLocal[\s\S]*?refreshRunningProjection/u);
  assert.match(screen, /const area = document\.getElementById\('ege_mock_area'\)[\s\S]*?area\.querySelectorAll\('input\[type=radio\]'\)/u);
  assert.doesNotMatch(screen, /document\.querySelectorAll\('input\[type=radio\]'\)/u);
});

test('route startup failures stay handled and the native Back action runs leave hooks', () => {
  assert.match(screen, /openRunner\(operation\)\.catch\(\(error\) => handleOpenFailure\(error, operation\)\)/u);
  assert.match(screen, /data-ege-action="retry-open"/u);
  assert.match(router, /function back\(\)[\s\S]*?runRouteHooks\(id,previous\)/u);
  assert.match(screen, /openEpoch/u);
  assert.match(screen, /function openOperationCurrent\(/u);
  assert.match(screen, /await loadEgeMockPublicForm\(\)[\s\S]*?openOperationCurrent/u);
  assert.match(screen, /await localRunner\.dispatch\(\{ type: 'restore'/u);
  assert.match(screen, /if \(!openOperationCurrent\(operation\)\) return/u);
  assert.match(screen, /await handleRunnerError\(error,[\s\S]*?renderUnavailableAttempt\(\)[\s\S]*?return/u);
  assert.match(screen, /Состояние попытки не удалось подтвердить/u);
});

test('authority reset clears the old-owner DOM before invalidation can continue', () => {
  assert.match(screen, /function clearPrivateRunnerDom\(/u);
  assert.match(screen, /function resetRunnerState\([^)]*\)[\s\S]*?clearPrivateRunnerDom\(\)/u);
  assert.match(screen, /function resetRunner\(\) \{ resetRunnerState\(\); \}/u);
  assert.match(screen, /apiIsAuthorityFailure\(error\)[\s\S]*?resetRunner\(\)[\s\S]*?invalidateLearningAuthority/u);
  assert.match(screen, /EGE_MOCK_ATTEMPT_NOT_FOUND[\s\S]*?EGE_MOCK_ATTEMPT_OWNER_CHANGED[\s\S]*?EGE_MOCK_WRITTEN_LOCAL_STATE_INVALIDATED[\s\S]*?dispatch\(\{ type: 'invalidate' \}\)[\s\S]*?resetRunnerState\(true, false\)/u);
  assert.match(screen, /const authorityCurrent[\s\S]*?runner === localRunner[\s\S]*?openOperationCurrent\(operation\)/u);
  assert.match(screen, /authority:[\s\S]*?commitEgeMockOwnerMutation[\s\S]*?authorityCurrent/u);
  assert.match(app, /function commitEgeMockOwnerMutation\([\s\S]*?withDurableOwnerIncarnationLock[\s\S]*?canCommit\(\)!==true/u);
  assert.match(screen, /type: 'invalidate'/u);
  assert.match(screen, /invalidation === 'unavailable'[\s\S]*?renderUnavailableAttempt/u);
  assert.match(screen, /catch \(invalidationError\)[\s\S]*?return 'unavailable'/u);
  assert.match(runnerSource, /EGE_MOCK_WRITTEN_LOCAL_STATE_INVALIDATED/u);
  assert.match(screen, /event\.key === runnerInvalidationKey/u);
});

test('the public account-deletion seam purges the exact EGE owner state and form caches', () => {
  assert.match(sync, /async function purgeOwnerLocalData\(/u);
  assert.match(sync, /easyboost-ege-mock-written-v1:/u);
  assert.match(sync, /easyboost-ege-mock-written-v1:[^\n]*:invalidation/u);
  assert.match(sync, /easyboost-ege-mock-assets-v1-/u);
  assert.match(sync, /easyboost-ege-mock-form-v1-/u);
  assert.match(sync, /await purgeOwnerLocalData/u);
});
