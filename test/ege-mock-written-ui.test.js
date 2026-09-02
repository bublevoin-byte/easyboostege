import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const [markup, styles, screen, entry, screenLoader, worker, app, sync, router, runnerSource, performanceSource, performanceBaseline] = await Promise.all([
  fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/ege-mock.css', import.meta.url), 'utf8'),
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
  assert.match(styles, /\.ege-mock :is\(button, input:not\(\[type="radio"\]\):not\(\[type="checkbox"\]\), select, textarea, summary\)\s*\{[^}]*min-block-size:\s*var\(--aisy-touch-target\)/su);
  assert.match(styles, /\.ege-mock__choice input\s*\{[^}]*min-block-size:\s*20px[^}]*block-size:\s*20px/su);
  assert.match(styles, /\.ege-mock__choice:focus-within span\s*\{[^}]*outline:/su);
  assert.match(styles, /\.ege-mock\s*\{[^}]*overflow-x:\s*(?:clip|hidden)/su);
  assert.match(styles, /@media\s*\(prefers-reduced-motion:\s*reduce\)/u);
  assert.match(screen, /blankPositions/u);
  assert.match(screen, /currentEgeMockOwnerBinding/u);
  assert.match(screen, /apiResponseOwner\(result\) !== owner\.username/u);
  assert.match(screen, /apiResponseServerTime/u);
  assert.match(screen, /'Idempotency-Key': input\.idempotencyKey/u);
  assert.match(screen, /type: 'completeObjective'/u);
  assert.match(screen, /dataset\.egeAction === 'run-assessment-after-renewal'[\s\S]*?type: 'runAssessmentAfterRenewal'/u,
    'the canonical subscription block exposes only an explicit post-renewal command');
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
  const ownedReleasePruner = worker.slice(
    worker.indexOf('function obsoleteAisyReleaseCache'),
    worker.indexOf('async function pruneObsoleteAisyReleasesIfSafe'),
  );
  assert.doesNotMatch(ownedReleasePruner, /easyboost-ege-mock-assets-v1-/u,
    'exact form caches are learner runtime data, not obsolete release-owned caches');
  assert.match(worker, /matchEgeMockAsset\(url,requestedCache,rangeHeader\(request\)\)/u);
  assert.match(worker, /searchParams\.get\('egeMockAssetCache'\)/u);
  assert.match(worker, /caches\.open\(requestedCache\)/u);
  const exactAssetMatcher = worker.slice(
    worker.indexOf('async function matchEgeMockAsset'), worker.indexOf('const EGE_MOCK_FORM_CACHE'),
  );
  assert.doesNotMatch(exactAssetMatcher, /for\(const name of names\)/u);
  assert.doesNotMatch(worker, /\/api\/v1\/ege-mocks[^\n]*cache/u);
  assert.match(app, /function offlineEgeMockContinuation\(\)/u,
    'an already-authorized learner can still restore the exact local runner');
  assert.doesNotMatch(app, /offlineEgeMock:true/u,
    'a failed authority check must not open the exact local runner');
  assert.match(screen, /listeningModule\.registerPlay\(plays, group, 2\)/u);
  assert.match(screen, /normalizeEgeMockSelection/u);
  assert.match(screen, /type: 'refreshLocal'/u);
  assert.doesNotMatch(screen, /<audio controls/u);
});

test('same-phase synchronization and exact-owner storage merges refresh status without replacing focus', () => {
  assert.match(screen, /function refreshRunningProjection\(/u);
  assert.match(screen, /function refreshRunningProjection\([^)]*\) \{\s*if \(oralRunner\) return;/u,
    'a late written refresh cannot rewrite the active oral timer and status card');
  assert.match(screen, /snapshot\.phase === before[\s\S]*?refreshRunningProjection\(snapshot\)/u);
  assert.match(screen, /event\.key === runnerStorageKey/u);
  assert.match(screen, /document\.activeElement/u);
  assert.match(screen, /refreshLocal[\s\S]*?refreshRunningProjection/u);
  assert.match(screen, /const area = document\.getElementById\('ege_mock_area'\)[\s\S]*?area\.querySelectorAll\('input\[type=radio\]'\)/u);
  assert.doesNotMatch(screen, /document\.querySelectorAll\('input\[type=radio\]'\)/u);
});

test('oral screen submit cannot send candidate-owned recording material', () => {
  const transport = screen.match(/async submit\(candidateId, input\) \{([\s\S]*?)\n    \},/u)?.[1];
  assert.ok(transport, 'oral submit transport must remain an explicit reviewable seam');
  assert.match(transport, /expectedRevision: input\.expectedRevision/u);
  assert.doesNotMatch(transport, /recordings/u);
  assert.match(screen, /createEgeMockOralRunner\(\{[\s\S]*?attemptId,[\s\S]*?attemptOwnerGeneration/u,
    'the oral runner is bound to the exact written attempt before local restore');
});

test('oral UI announces its section, authoritative timer warnings and exact task changes', () => {
  assert.match(markup, /id="ege_mock_part"/u);
  assert.match(screen, /const ORAL_WARNING_MINUTES = Object\.freeze\(\[10, 5, 1\]\)/u);
  assert.match(screen, /function renderOralHeader\([\s\S]*?УСТНАЯ ЧАСТЬ[\s\S]*?role', 'timer'/u);
  assert.match(screen, /snapshot\.authorityNowMs/u);
  assert.match(screen, /oralMedia\.assetUrl\(pair\.src\)/u);
  assert.match(screen, /await media\.preflight\([\s\S]*?await beginAutomaticOralRecording\(restored, media\)/u,
    'a reload inside the authoritative recording phase restarts capture for the remaining interval');
  const tick = screen.match(/async function tickOral\(\) \{([\s\S]*?)\n\}/u)?.[1] || '';
  assert.ok(tick.indexOf('stageDeadlineAt') < tick.indexOf("type: 'tick'"),
    'the expiring recording is finalized before overall automatic submit');
  assert.match(screen, /oralProjectionIdentity\(before\) !== oralProjectionIdentity\(snapshot\)[\s\S]*?requestAnimationFrame[\s\S]*?focus/u);
});

test('cross-tab oral adoption discards the old response capture before starting the adopted one', () => {
  assert.match(screen, /createEgeMockOralRunner\(\{[\s\S]*?lockManager: navigator\.locks/u);
  assert.match(screen, /async function cancelAutomaticOralRecording\([\s\S]*?media\?\.cancelRecording\?\.\([\s\S]*?oralRecordingActive = false[\s\S]*?oralCaptured = null/u);
  const storageHandler = screen.slice(screen.indexOf("window.addEventListener('storage'"));
  assert.match(storageHandler,
    /const beforeIdentity = oralProjectionIdentity\(candidateRunner\.snapshot\(\)\)[\s\S]*?const incomingIdentity = oralStoredProjectionIdentity\(event\.newValue\)[\s\S]*?const captureNeedsRebinding = incomingIdentity !== '' && incomingIdentity !== beforeIdentity/u,
    'same-cursor writes from another tab must not repeatedly destroy the active recording');
  assert.match(storageHandler,
    /if \(captureNeedsRebinding\) await cancelAutomaticOralRecording\(\)[\s\S]*?type: 'refreshLocal'/u,
    'a known cursor change cancels the stale recorder before adopting remote progress');
  assert.match(storageHandler,
    /const projectionChanged = oralProjectionIdentity\(snapshot\) !== beforeIdentity[\s\S]*?if \(projectionChanged && !captureNeedsRebinding\) await cancelAutomaticOralRecording\(\)/u,
    'authoritative changes that were not readable from storage still discard stale capture');
  assert.ok(storageHandler.indexOf("type: 'refreshLocal'")
    < storageHandler.indexOf('await beginAutomaticOralRecording(snapshot, candidateMedia)'));
});

test('oral cross-tab UI has one durable capture owner and storage adoption cannot feed back', () => {
  assert.match(screen, /hasRecordingLease\(\)[\s\S]*?acquireRecordingLease\(identity\)/u);
  const storageHandler = screen.slice(screen.indexOf("window.addEventListener('storage'"));
  assert.match(storageHandler, /type: 'refreshLocal'/u);
  assert.doesNotMatch(storageHandler.slice(0, storageHandler.indexOf('if (runner &&')),
    /type: 'restore'/u, 'a peer storage event must not perform GET + persist + another storage event');
});

test('oral cross-tab and reconnect merges reload the complete result projection', () => {
  const onlineHandler = screen.slice(
    screen.indexOf("window.addEventListener('online'"),
    screen.indexOf("window.addEventListener('storage'"),
  );
  assert.match(onlineHandler,
    /candidateRunner\.dispatch\([\s\S]*?reloadFinalResultAfterAssessmentMerge\(operation, snapshot\)/u,
    'oral reconnect cannot retain a stale total, forecast, recommendations or history');
  const storageHandler = screen.slice(screen.indexOf("window.addEventListener('storage'"));
  assert.match(storageHandler,
    /candidateRunner\.dispatch\(\{ type: 'refreshLocal' \}\)[\s\S]*?reloadFinalResultAfterAssessmentMerge\(operation, snapshot\)/u,
    'oral cross-tab adoption reloads the same complete result projection as same-tab assessment');
});

test('oral stage countdown is quiet and the verified task-42 composite spans the mobile grid', () => {
  assert.match(screen, /<p><span>Этап<\/span><strong>/u);
  assert.doesNotMatch(screen, /<p role="status"><span>Этап<\/span>/u);
  assert.match(styles, /\.ege-mock__oral-photos img\s*\{[^}]*grid-column:\s*1 \/ -1/u);
});

test('a failed oral reopen preserves its actionable error instead of returning to a silent written card', () => {
  assert.match(screen, /const opened = await ensureOralRunner\(\);[\s\S]*?if \(!opened\) return/u);
});

test('a failed result refresh keeps stale authority explicit and retryable', () => {
  const authoritativeLoader = screen.slice(
    screen.indexOf('async function loadAuthoritativeResultTuple'),
    screen.indexOf('async function loadFinalResult'),
  );
  const loader = screen.slice(
    screen.indexOf('async function loadFinalResult'),
    screen.indexOf('function finalAssessmentControls'),
  );
  assert.match(loader, /await handleRunnerError\(error, operation\)/u,
    'owner failures must invalidate through the shared authority seam');
  assert.match(loader, /return false/u);
  assert.match(authoritativeLoader,
    /attempts\/history\?attemptId=\$\{encodeURIComponent\(attemptId\)\}/u,
    'the paired history snapshot pins the exact restored terminal attempt inside its bounded window');
  assert.match(loader, /loadAuthoritativeResultTuple\(operation\.owner, attemptId\)/u,
    'the live runner consumes the shared owner-bound result and history tuple');
  assert.match(loader,
    /const \{ result, history, consistent \} = tuple;[\s\S]*?if \(!openOperationCurrent\(operation\) \|\| runner\?\.snapshot\(\)\.attemptId !== attemptId\) return;[\s\S]*?if \(!consistent\) \{[\s\S]*?finalResultLoadAuthority\.invalidate\(attemptId\)/u,
    'a stale route, owner or runner response cannot mutate the current result-load authority');
  assert.match(screen,
    /finalResultLoadFailedAttemptId === snapshot\.attemptId[\s\S]*?data-ege-action="result-refresh"/u,
    'a stale rendered result exposes a retry action instead of only an error string');
  assert.match(screen,
    /const refreshed = await loadFinalResult\(operation, finalResultAttemptId\);[\s\S]*?if \(!refreshed\) return;[\s\S]*?visibleError = ''/u,
    'assessment completion cannot erase a failed authoritative refresh');
});

test('a higher cross-tab assessment revision invalidates and reloads the complete result projection', () => {
  assert.match(screen, /let finalResultLoadingAttemptId = ''/u,
    'the first in-flight result request records which attempt it belongs to');
  const refresh = screen.slice(
    screen.indexOf('async function reloadFinalResultAfterAssessmentMerge'),
    screen.indexOf('function finalAssessmentControls'),
  );
  assert.match(refresh,
    /finalResultLoadingAttemptId === attemptId[\s\S]*?writingChanged[\s\S]*?speakingChanged[\s\S]*?finalResultLoadAuthority\.invalidate\(attemptId\)[\s\S]*?finalResult = null[\s\S]*?finalHistory = null[\s\S]*?finalResultReloadQueuedAttemptId = attemptId[\s\S]*?await loadFinalResult\(operation, attemptId\)/u,
    'one higher assessment revision reloads score, forecast, recommendations and history together');
  const loader = screen.slice(
    screen.indexOf('async function loadFinalResult'),
    screen.indexOf('function finalAssessmentControls'),
  );
  assert.match(loader,
    /finalResultLoading = false[\s\S]*?queuedAttemptId[\s\S]*?queueMicrotask\(\(\) => loadFinalResult\(operation, queuedAttemptId\)\)/u,
    'a storage merge during an older in-flight GET always schedules one authoritative follow-up');
  assert.match(loader,
    /finalResultRequiredAttemptId === attemptId[\s\S]*?loadedAssessmentRevision < finalResultRequiredAssessmentRevision/u,
    'an outdated first response cannot overwrite the higher cross-tab assessment revision');
  const storageHandler = screen.slice(screen.indexOf("window.addEventListener('storage'"));
  assert.match(storageHandler,
    /dispatch\(\{ type: 'refreshLocal' \}\)\.then\(async \(snapshot\)[\s\S]*?reloadFinalResultAfterAssessmentMerge\(operation, snapshot\)/u,
    'the cross-tab merge seam cannot keep the already-rendered pending result');
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

test('oral initialization is epoch-bound across every asynchronous media boundary', () => {
  assert.match(screen,
    /const oralOperation = \{[\s\S]*?epoch: openEpoch[\s\S]*?candidate[\s\S]*?media[\s\S]*?\};/u);
  assert.match(screen,
    /await candidate\.dispatch\(\{ type: 'restore', form \}\);[\s\S]*?if \(!oralOperationCurrent\(oralOperation\)\)[\s\S]*?media\.dispose/u,
    'a stale restore is disposed before it can install global oral state');
  assert.match(screen,
    /await media\.preflight\([\s\S]*?if \(!oralOperationCurrent\(oralOperation\)\)[\s\S]*?media\.dispose/u,
    'a stale preflight is disposed before it can acquire the microphone');
  assert.match(screen,
    /finally\(\(\) => \{[\s\S]*?if \(oralOpening === guardedOpening\) oralOpening = null/u,
    'an old opening promise cannot clear a newer oral opening');
  assert.match(screen,
    /await media\.startRecording\(remainingSeconds\);[\s\S]*?if \(media !== oralMedia\)[\s\S]*?cancelRecording/u,
    'a recorder resolved after route invalidation is cancelled instead of reviving capture state');
});

test('the public account-deletion seam purges the exact EGE owner state and form caches', () => {
  assert.match(sync, /async function purgeOwnerLocalData\(/u);
  assert.match(sync, /easyboost-ege-mock-written-v1:/u);
  assert.match(sync, /easyboost-ege-mock-written-v1:[^\n]*:invalidation/u);
  assert.match(sync, /easyboost-ege-mock-assets-v1-/u);
  assert.match(sync, /easyboost-ege-mock-form-v1-/u);
  assert.match(sync, /await purgeOwnerLocalData/u);
});
