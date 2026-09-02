import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const releaseRunner = await fs.readFile(new URL('../scripts/run-aisy-release-e2e.js', import.meta.url), 'utf8');
const performanceE2e = await fs.readFile(new URL('../e2e/performance.test.js', import.meta.url), 'utf8');
const egeWrittenE2e = await fs.readFile(new URL('../e2e/ege-mock-written.test.js', import.meta.url), 'utf8');
const egeWorkerContract = await fs.readFile(
  new URL('./ege-mock-written-service-worker.test.js', import.meta.url), 'utf8',
);
const pwaReleaseE2e = await fs.readFile(new URL('../e2e/aisy-pwa-release.test.js', import.meta.url), 'utf8');
const pwaRuntime = await fs.readFile(new URL('../public/pwa.js', import.meta.url), 'utf8');
const serviceWorker = await fs.readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8');
const appMarkup = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const shellStyles = await fs.readFile(new URL('../public/aisy-shell.css', import.meta.url), 'utf8');
const ciWorkflow = await fs.readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const stagingDeployWorkflow = await fs.readFile(
  new URL('../.github/workflows/deploy-staging.yml', import.meta.url), 'utf8',
);
const releaseChecklist = await fs.readFile(new URL('../RELEASE_CHECKLIST.md', import.meta.url), 'utf8');
const approvedSpec = await fs.readFile(
  new URL('../.scratch/aisy-production-ui-a/spec.md', import.meta.url), 'utf8',
);
const ticketEleven = await fs.readFile(
  new URL('../.scratch/aisy-production-ui-a/issues/11-pwa-release-evidence.md', import.meta.url), 'utf8',
);
const knownLimitations = await fs.readFile(new URL('../docs/KNOWN_LIMITATIONS.md', import.meta.url), 'utf8');
const deploymentGuide = await fs.readFile(new URL('../README_DEPLOY.md', import.meta.url), 'utf8');
const rootProgress = await fs.readFile(new URL('../PROGRESS.md', import.meta.url), 'utf8');
const performanceBaseline = await fs.readFile(
  new URL('../docs/PERFORMANCE_BASELINE.md', import.meta.url), 'utf8',
);
const pwaReleaseGuide = await fs.readFile(new URL('../docs/AISY_PWA_RELEASE.md', import.meta.url), 'utf8');
const uxOperations = await fs.readFile(new URL('../docs/AISY_UX_OPERATIONS.md', import.meta.url), 'utf8');
const compactProgress = await fs.readFile(
  new URL('../.scratch/aisy-production-ui-a/progress.md', import.meta.url), 'utf8',
);
const artifactUnitContract = await fs.readFile(
  new URL('./release-artifact-integrity.test.js', import.meta.url), 'utf8',
);
const artifactPostbuildContract = await fs.readFile(
  new URL('./release-artifact-postbuild.js', import.meta.url), 'utf8',
);

test('source unit artifact verification does not read ignored dist before the sole build', async () => {
  const cleanDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-clean-unit-contour-'));
  const cleanEnvironment = { ...process.env };
  delete cleanEnvironment.NODE_TEST_CONTEXT;
  try {
    const result = spawnSync(process.execPath, [
      '--test', fileURLToPath(new URL('./release-artifact-integrity.test.js', import.meta.url)),
    ], {
      cwd: cleanDirectory,
      encoding: 'utf8',
      env: cleanEnvironment,
      timeout: 30_000,
    });
    assert.equal(result.status, 0,
      `source unit contour must not require dist/public\n${result.stdout}\n${result.stderr}`);
    await assert.rejects(fs.access(path.join(cleanDirectory, 'dist', 'public')),
      'source unit contour must not synthesize a built artifact');
  } finally {
    await fs.rm(cleanDirectory, { recursive: true, force: true });
  }
});

test('heavy Grammar presentation is lazy on the network and pre-cached for first offline use', async () => {
  const [main, screens, build] = await Promise.all([
    fs.readFile(new URL('../public/main.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/screens.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../scripts/build-frontend.js', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(main, /import \* as grammarScreen from '\.\/screens\/grammar\.js'/u);
  assert.match(screens, /scr3:function\(\)\{return import\('\.\/screens\/grammar\.js'\)\}/u);
  assert.match(build, /const offlineEntryModules = \[[\s\S]*'screens\/grammar\.js'/u);
});

test('the default and dedicated release gates build once and run one unique Aisy learner inventory', async () => {
  for (const script of ['test:e2e', 'test:e2e:aisy']) {
    assert.equal(packageJson.scripts[script], 'npm run build:frontend && npm run test:e2e:aisy:built');
  }
  const inventoryStart = releaseRunner.indexOf(
    'export const AISY_RELEASE_E2E_FILES = Object.freeze([',
  );
  const inventoryEnd = releaseRunner.indexOf(']);', inventoryStart);
  assert.ok(inventoryStart >= 0 && inventoryEnd > inventoryStart,
    'canonical release inventory must remain a fixed source list');
  const inventorySource = releaseRunner.slice(inventoryStart, inventoryEnd);
  const files = [...inventorySource.matchAll(/'((?:e2e\/)[^']+\.test\.js)'/gu)]
    .map((match) => match[1]);
  assert.equal(files.length, new Set(files).size, 'expensive browser scenarios must not be duplicated');
  for (const file of [
    'e2e/aisy-pwa-release.test.js', 'e2e/aisy-accessibility.test.js',
    'e2e/aisy-learner-release.test.js', 'e2e/aisy-practice.test.js',
    'e2e/grammar-2-release.test.js', 'e2e/vocabulary-library.test.js',
    'e2e/reading-listening-paper.test.js', 'e2e/aisy-writing-paper.test.js',
    'e2e/aisy-writing-offline-cache.test.js', 'e2e/aisy-speaking-paper.test.js',
    'e2e/aisy-ege-hub.test.js', 'e2e/ege-mock-release.test.js',
    'e2e/aisy-progress-profile.test.js',
  ]) {
    assert.ok(files.includes(file), `${file} must remain in the release inventory`);
  }
  const releaseSteps = packageJson.scripts['test:release:aisy'].split(' && ');
  assert.deepEqual(releaseSteps, [
    'npm run lint', 'npm run check', 'npm test', 'npm run security:secrets', 'npm run build:frontend',
    'npm run release:artifact:verify', 'npm run test:artifact:built', 'npm run test:e2e:aisy:built',
    'npm run test:e2e:performance', 'npm run security:history', 'git diff --check',
  ]);
  assert.equal(releaseSteps.indexOf('npm run security:secrets'),
    releaseSteps.indexOf('npm run build:frontend') - 1,
    'the context/secret guard must run immediately before the sole candidate build');
  assert.ok(releaseSteps.indexOf('npm run security:secrets') < releaseSteps.indexOf('npm run build:frontend'));
  assert.equal(releaseSteps.filter((step) => step === 'npm run build:frontend').length, 1,
    'the release chain must create the final candidate exactly once after all unit tests');
  assert.equal(packageJson.scripts['release:artifact:verify'],
    'node scripts/verify-release-artifact.js');
  assert.equal(packageJson.scripts['test:artifact:built'],
    'node --test test/release-artifact-postbuild.js');
  assert.doesNotMatch(artifactUnitContract, /path\.resolve\(['"]dist\/public['"]\)/u,
    'source artifact unit contracts must stay fixture-only');
  assert.match(artifactPostbuildContract,
    /assert\.equal\(result\.assets, 553\)[\s\S]*assert\.equal\(result\.files, 554\)/u,
    'the explicit postbuild contour must retain the complete built inventory count');
  const ciCommands = [...ciWorkflow.matchAll(/^\s*run:\s*(npm run [^\r\n]+)$/gmu)]
    .map((match) => match[1]);
  assert.equal(ciCommands.filter((step) => step === 'npm run test:release:aisy').length, 1,
    'clean CI must delegate the canonical one-build chain to exactly one release wrapper');
  assert.match(ciWorkflow,
    /name: Run the canonical one-build release gate[\s\S]*EASYBOOST_TEST_CONCURRENCY: 1[\s\S]*run: npm run test:release:aisy/u,
    'hosted CI must serialize process-authority suites without slowing ordinary local npm test');
  assert.equal(packageJson.scripts.test, 'node scripts/run-unit-tests.js');
  assert.equal(ciCommands.includes('npm run build:frontend'), false,
    'CI must not duplicate steps already owned by the canonical release wrapper');
  assert.equal(ciCommands.includes('npm run test:e2e'), false,
    'CI must not call the convenience E2E command that performs another build');
  for (const duplicated of [
    'npm run lint', 'npm run check', 'npm test', 'npm run security:secrets',
    'npm run release:artifact:verify', 'npm run test:artifact:built', 'npm run test:e2e:aisy:built',
    'npm run test:e2e:performance', 'npm run security:history',
  ]) {
    assert.equal(ciCommands.includes(duplicated), false,
      `${duplicated} must remain inside the one canonical release wrapper`);
  }
  assert.equal((releaseChecklist.match(/^npm run test:release:aisy$/gmu) ?? []).length, 1,
    'the canonical release checklist must call the one-build wrapper exactly once');
  assert.doesNotMatch(releaseChecklist, /^npm run build:frontend$/gmu,
    'the checklist must not manually reproduce the wrapper build contour');
  assert.doesNotMatch(releaseChecklist, /^npm run test:e2e$/gmu,
    'the checklist must not call a convenience command that performs another build');
  assert.doesNotMatch(releaseChecklist, /^npm run release:artifact:verify$/mu);
  assert.doesNotMatch(releaseChecklist, /^npm run test:artifact:built$/mu);
  assert.doesNotMatch(releaseChecklist, /^npm run test:e2e:aisy:built$/mu);
  assert.doesNotMatch(egeWorkerContract, /from 'node:child_process'/u,
    'npm test must not invoke any nested frontend build process');
  assert.doesNotMatch(egeWorkerContract, /dist\/public/u,
    'unit EGE lifecycle tests must remain independent of the final candidate artifact');
  assert.doesNotMatch(pwaReleaseE2e, /__pwaUpdateApply|detail\?*\.apply/u,
    'exact predecessor consent must use the visible production Apply control, never an injected callback');
  assert.match(pwaReleaseE2e, /reloadIntoCandidateUpdateUi[\s\S]*#pwa_update:not\(\[hidden\]\)[\s\S]*Обновить после задания/u,
    'exact predecessor flow must ordinary-reload into the real candidate update UI');
});

test('GitHub CI reserves an honest end-to-end release budget', () => {
  const ciTimeoutMinutes = Number(ciWorkflow.match(/^\s*timeout-minutes:\s*(\d+)\s*$/mu)?.[1]);
  assert.ok(ciTimeoutMinutes >= 120,
    'the CI job must cover the ~31-minute unit phase, the rest of the wrapper, cross-browser gates and cold-run margin');
});

test('staging release helpers run on the project-supported Node major', () => {
  const setupNodeIndex = stagingDeployWorkflow.indexOf('- uses: actions/setup-node@v4');
  const archiveIndex = stagingDeployWorkflow.indexOf('- name: Create immutable release archive');
  assert.ok(setupNodeIndex >= 0 && setupNodeIndex < archiveIndex,
    'staging must select its supported Node runtime before invoking archive helpers');
  const setupNodeStep = stagingDeployWorkflow.slice(setupNodeIndex, archiveIndex);
  assert.match(setupNodeStep, /^\s*node-version:\s*22\s*$/mu,
    'staging release helpers must run on the same supported Node major as CI and package.json');
});

test('PWA update focus restoration rejects document roots and verifies the focus move', () => {
  assert.match(pwaRuntime, /element !== document\.body && element !== document\.documentElement/u,
    'body/html must never be remembered as a task focus target');
  assert.match(pwaRuntime, /document\.activeElement === target/u,
    'focus restoration must verify that focus actually moved');
  assert.match(pwaRuntime,
    /querySelectorAll\('\[data-aisy-shell-focus\], main, button, \[href\], input, textarea, select'\)/u,
    'body-origin restoration must prefer the active screen main landmark over an arbitrary control');
  assert.match(pwaRuntime,
    /documentRootTabTraversal[\s\S]*event\.key !== 'Tab'[\s\S]*document\.activeElement === document\.body/u,
    'a Tab traversal originating at the document root must not capture an incidental task control');
  assert.match(pwaRuntime,
    /current\.pathname === '\/'[\s\S]*searchParams\.has\('login_code'\)[\s\S]*history\.replaceState/u,
    'a consented update must clear the network-only legacy callback before an offline reload');
  assert.match(pwaReleaseE2e, /body-origin keyboard snooze/u,
    'the built PWA must exercise keyboard traversal from body into the notice');
});

test('service-worker retirement is bound to one strict immutable predecessor authority', () => {
  assert.match(serviceWorker,
    /const EGE_MOCK_EXEC_CACHE='easyboost-ege-mock-exec-v1-'-?\+CACHE_NAME/u,
    'identical EGE path graphs must still use release-distinct executable caches');
  assert.match(serviceWorker,
    /PWA_RETIREMENT_SCHEMA='aisy-pwa-retirement-plan-v2'[\s\S]*PWA_RETIREMENT_MAX_BYTES=1024[\s\S]*PWA_RETIREMENT_MAX_CACHES=4/u,
    'the durable authority must have exact schema, byte and count bounds');
  assert.match(serviceWorker,
    /predecessorRetirementAuthority[\s\S]*PREDECESSOR_COMPATIBILITY[\s\S]*baseCommit[\s\S]*contentSha256[\s\S]*cacheName/u,
    'cache ownership must come from the immutable compatibility identity');
  const persist = serviceWorker.match(
    /async function persistReleaseRetirementPlan\(\)[\s\S]*?\n\}/u,
  )?.[0] ?? '';
  assert.match(persist, /expectedReleaseRetirementPlan[\s\S]*cache\.put\(PWA_RETIREMENT_PLAN/u,
    'activation must atomically persist the exact compatibility authority');
  assert.doesNotMatch(persist, /caches\.keys\(|startsWith\(/u,
    'the retirement record must never be a broad dynamic cache-name snapshot');
  assert.match(serviceWorker,
    /parseReleaseRetirementPlan[\s\S]*arrayBuffer\(\)[\s\S]*PWA_RETIREMENT_MAX_BYTES[\s\S]*validateReleaseRetirementPlan/u,
    'persisted authority must be byte-bounded and validated before use');
  const prune = serviceWorker.match(/async function pruneObsoleteAisyReleasesIfSafe\(\)[\s\S]*?\n\}/u)?.[0] ?? '';
  assert.match(prune, /readReleaseRetirementPlan/u);
  assert.doesNotMatch(prune, /caches\.keys\(/u,
    'delayed pruning must never rescan and classify a future worker generation');
  assert.match(serviceWorker,
    /activateRelease[\s\S]*persistReleaseRetirementPlan\(\)[\s\S]*markReleaseActivated/u,
    'the exact plan must be durable during activation before delayed retirement is possible');
});

test('waiting-worker notice stays inside the centered portrait frame at desktop width', () => {
  assert.match(appMarkup,
    /<div id="frame">[\s\S]*<section id="pwa_update"[\s\S]*<\/section>\s*<\/div>\s*<dialog id="account_action_global_notice"/u,
    'the update notice must be a direct final child of the portrait frame');
  const frameRule = shellStyles.match(/#frame\s*\{([\s\S]*?)\}/u)?.[1] ?? '';
  const noticeRule = shellStyles.match(/\.pwa-update\s*\{([\s\S]*?)\}/u)?.[1] ?? '';
  assert.match(frameRule, /position:\s*relative/u);
  assert.match(noticeRule, /position:\s*absolute/u);
  assert.match(noticeRule, /inline-size:[\s\S]*?100%/u);
  assert.doesNotMatch(noticeRule, /position:\s*fixed|100vw/u);
  assert.match(pwaReleaseE2e, /width:\s*1440,\s*height:\s*900/u,
    'the real waiting-worker seam must retain a desktop viewport regression');
  assert.match(pwaReleaseE2e, /noticeInsideFrame/u,
    'the browser regression must prove all notice edges stay inside the centered frame');
});

test('waiting-worker Apply remains a paper secondary beside the visible deep-task primary', () => {
  const applyTag = appMarkup.match(
    /<button\b(?=[^>]*\bid="pwa_update_apply")(?=[^>]*\bclass="[^"]*")[^>]*>/u,
  )?.[0] ?? '';
  assert.match(applyTag, /\bclass="[^"]*\baisy-button\b[^"]*\baisy-button--secondary\b[^"]*"/u,
    'the update notice must not introduce a second solid-coral CTA');
  assert.match(pwaReleaseE2e, /updateApplySecondary/u,
    'the real browser matrix must observe the secondary update control beside each deep task');
  assert.match(pwaReleaseE2e, /updateApplyBackground[\s\S]*deepCtaBackground/u,
    'the browser matrix must compare rendered update and deep-task action treatments');
});

test('Ticket 11 has a truthful bounded release-safety scope amendment', () => {
  for (const [label, document] of [
    ['approved spec', approvedSpec], ['Ticket 11', ticketEleven],
  ]) {
    assert.match(document, /Release-safety scope amendment[^\n]*2026-08-29/iu, label);
    assert.match(document, /`\/autopilot`[\s\S]*`продолжай`/u, label);
    assert.match(document, /не (?:являются|является)[^\n]*(?:решением|одобрением)[^\n]*(?:staging|визуаль|product)/iu,
      `${label} must not invent a separately spoken product or staging decision`);
    assert.match(document, /(?:deploy|deployment)[\s\S]*(?:provider|провайдер)[\s\S]*(?:secret|секрет)/iu,
      `${label} must keep live external actions explicitly outside the amendment`);
  }
  assert.match(approvedSpec, /редизайн staging-инструментов за пределами этого bounded release-safety seam/iu);
  assert.doesNotMatch(knownLimitations, /narrow security exception/iu);
  assert.match(knownLimitations, /release-safety scope amendment[^\n]*2026-08-29/iu);
});

test('superseded Cycle 8 and 10 observations stay historical while consumers cite the final wrapper', () => {
  const staleObservedTokens = [
    'sha256-fc7996d1f54f6da75614e67f51a4e890ca603ef2f0aed498dbb1c3d86cfdfc71',
    '06afd702b65849cf80ec940edb3e1b6ebad6ab8fd6570429ae8a004ded08f601',
    '26/26',
    '91 087',
    '89,0 КБ',
  ];
  const consumerOnlyStaleTokens = [...staleObservedTokens, '92–100 мс', '81,9 КБ'];
  for (const [label, document] of [
    ['README', deploymentGuide],
    ['release checklist', releaseChecklist],
    ['root progress', rootProgress.split(/^## /mu)[0]],
    ['PWA release contract', pwaReleaseGuide],
    ['UX operations', uxOperations],
    ['compact progress', compactProgress],
  ]) {
    for (const token of consumerOnlyStaleTokens) {
      assert.equal(document.includes(token), false,
        `${label} must link to historical evidence instead of repeating stale observation ${token}`);
    }
    assert.ok(document.includes('d518f4a54e7b03beb357a69f7dc6380cd31befc5a11634c1ddd0df216021e290'),
      `${label} must cite the current verified artifact`);
    assert.match(document, /26[^\n]{0,80}(?:Chromium|хромиум)/iu,
      `${label} must cite the final browser contour`);
  }
  assert.match(pwaReleaseGuide, /single final wrapper passed/iu,
    'the handoff must state that final verification completed');
  const compactTicket = compactProgress.split(/\r?\n/u).find((line) => /^\| 11 /u.test(line)) ?? '';
  assert.match(compactTicket, /\| done \|/u,
    'the compact handoff must mark Ticket 11 complete after the final wrapper');

  assert.match(ticketEleven,
    /^## Historical Cycle 8\/10 evidence — superseded; not current release evidence$/mu);
  const historicalTicketBlock = ticketEleven.split(
    /^## Historical Cycle 8\/10 evidence — superseded; not current release evidence$/mu,
  )[1]?.split(/^## /mu)[0] ?? '';
  for (const token of staleObservedTokens) {
    assert.ok(historicalTicketBlock.includes(token), `historical Ticket 11 record must retain ${token}`);
  }
  assert.doesNotMatch(historicalTicketBlock, /Fresh Cycle 10|preserved artifact authority/iu);

  assert.match(performanceBaseline,
    /^# Historical Cycle 8 performance baseline — superseded; not current release evidence$/mu);
  assert.doesNotMatch(performanceBaseline,
    /## Текущий baseline|В текущей сборке|Свежий результат|Текущий сопоставимый baseline/iu);
  assert.match(performanceBaseline,
    /Текущие artifact\/E2E\/performance\s+evidence[\s\S]{0,160}недоступ[\s\S]{0,160}финаль/iu);
});

test('the learner release runtime fails closed around providers and network errors', async () => {
  const {
    createReleaseNetworkGuard, createReleaseServerEnvironment, prepareReleaseBrowserBoundary,
  } = await import(
    '../e2e/aisy-learner-release-safety.js'
  );
  const environment = createReleaseServerEnvironment({ PORT: '4321' }, {
    XAI_ENABLED: 'true',
    XAI_API_KEY: 'inherited-xai-secret',
    XAI_API_URL: 'https://provider.invalid/xai',
    XAI_RULE_SEARCH_URL: 'https://provider.invalid/search',
    XAI_VOICE_REALTIME_URL: 'wss://provider.invalid/voice',
    GROQ_ENABLED: 'true',
    GROQ_API_KEY: 'inherited-groq-secret',
    GROQ_API_URL: 'https://provider.invalid/groq',
    AZURE_SPEECH_KEY: 'inherited-azure-secret',
  });
  assert.equal(environment.PORT, '4321');
  for (const key of ['XAI_API_KEY', 'GROQ_API_KEY', 'AZURE_SPEECH_KEY']) {
    assert.equal(environment[key], '', `${key} must never reach the release child`);
  }
  assert.equal(environment.XAI_ENABLED, 'false');
  assert.equal(environment.GROQ_ENABLED, 'false');
  assert.equal(environment.VOICE_TUTOR_ENABLED, 'false');
  for (const key of [
    'XAI_API_URL', 'XAI_RULE_SEARCH_URL', 'XAI_VOICE_REALTIME_URL', 'GROQ_API_URL',
  ]) assert.match(environment[key], /^(?:http|ws):\/\/127\.0\.0\.1:9\//u);

  const guard = createReleaseNetworkGuard({
    allowedHttpResponses: [{ method: 'GET', path: '/empty', status: 404 }],
  });
  guard.recordConsoleError('Failed to load resource: online asset');
  guard.recordConsoleError('Unexpected application error');
  guard.recordHttpResponse('GET', '/empty', 404);
  guard.setOffline(true);
  guard.recordConsoleError('Failed to load resource: expected offline request');
  guard.recordRequestFailure('GET', '/offline', 'net::ERR_INTERNET_DISCONNECTED');
  guard.recordHttpResponse('GET', '/offline', 503);
  guard.setOffline(false);
  guard.recordRequestFailure('GET', '/missing.js', 'net::ERR_FAILED');
  guard.recordHttpResponse('GET', '/broken', 500);
  assert.deepEqual(guard.failures, [
    'console: Unexpected application error',
    'requestfailed: GET /missing.js (net::ERR_FAILED)',
    'http: GET /broken -> 500',
  ]);

  const firstPage = new EventEmitter();
  const browserContext = new EventEmitter();
  browserContext.pages = () => [firstPage];
  const hermeticRoutes = [];
  browserContext.route = async (routePattern, handler) => hermeticRoutes.push({ routePattern, handler });
  const browserGuards = await prepareReleaseBrowserBoundary(browserContext, {
    applicationOrigin: 'http://127.0.0.1:4321', networkGuard: guard,
  });
  assert.deepEqual(hermeticRoutes.map(({ routePattern }) => routePattern), ['**/*']);
  const routeOutcomes = [];
  const fakeRoute = (url) => ({
    request: () => ({ url: () => url }),
    continue: async () => routeOutcomes.push('continue'),
    fulfill: async () => routeOutcomes.push('fulfill'),
    abort: async () => routeOutcomes.push('abort'),
  });
  await hermeticRoutes[0].handler(fakeRoute('http://127.0.0.1:4321/app.js'));
  await hermeticRoutes[0].handler(fakeRoute(
    'http://127.0.0.1:4321/assets/fonts/manrope-cyrillic-variable.woff2',
  ));
  await hermeticRoutes[0].handler(fakeRoute(
    'http://127.0.0.1:4321/assets/fonts/nunito-latin-variable.woff2',
  ));
  await hermeticRoutes[0].handler(fakeRoute('https://fonts.googleapis.com/css2?family=Manrope'));
  await hermeticRoutes[0].handler(fakeRoute('https://fonts.gstatic.com/s/manrope/v1/remote.woff2'));
  await hermeticRoutes[0].handler(fakeRoute('https://analytics.invalid/collect?token=private'));
  assert.deepEqual(routeOutcomes, [
    'continue', 'continue', 'continue', 'abort', 'abort', 'abort',
  ]);
  browserContext.emit('requestfailed', {
    method: () => 'GET',
    url: () => 'https://fonts.googleapis.com/css2?family=Manrope',
    failure: () => ({ errorText: 'net::ERR_BLOCKED_BY_CLIENT' }),
  });
  assert.equal(guard.failures.at(-1),
    'requestfailed: GET https://fonts.googleapis.com (net::ERR_BLOCKED_BY_CLIENT)',
    'remote Google Fonts must fail the hermetic release guard like every external request');
  const localTheme = await fs.readFile(new URL('../public/aisy-theme.css', import.meta.url), 'utf8');
  assert.match(localTheme, /font-family:\s*"Aisy Manrope"[\s\S]*manrope-cyrillic-variable\.woff2/u);
  assert.match(localTheme, /font-family:\s*"Aisy Nunito"[\s\S]*nunito-latin-variable\.woff2/u);
  assert.doesNotMatch(localTheme, /fonts\.(?:googleapis|gstatic)\.com/iu);
  const crossTab = new EventEmitter();
  browserContext.emit('page', crossTab);
  crossTab.emit('pageerror', new Error('cross-tab failed'));
  crossTab.emit('console', {
    type: () => 'error', text: () => 'cross-tab console failed',
  });
  crossTab.emit('websocket', { url: () => 'wss://provider.invalid/realtime?ticket=private' });
  browserContext.emit('request', {
    method: () => 'POST', url: () => 'https://api.x.ai/v1/responses?token=private',
  });
  assert.deepEqual(browserGuards.browserFailures, ['pageerror: cross-tab failed']);
  assert.equal(guard.failures.at(-1), 'console: cross-tab console failed');
  assert.deepEqual(browserGuards.paidBoundaryCalls, [
    'WS wss://provider.invalid', 'POST https://api.x.ai',
  ]);

  const privateGuard = createReleaseNetworkGuard();
  privateGuard.recordRequestFailure(
    'GET', '/api/v1/ege-mocks/attempts/11111111-2222-4333-8444-555555555555/result?ticket=private',
    'failed token=private',
  );
  assert.deepEqual(privateGuard.failures, [
    'requestfailed: GET /api/v1/ege-mocks/attempts/:id/result (failed token=<redacted>)',
  ]);

  const offlineGuard = createReleaseNetworkGuard();
  offlineGuard.setOffline(true);
  offlineGuard.recordRequestFailure(
    'GET', 'https://analytics.invalid/collect?token=private', 'blocked token=private',
    { external: true },
  );
  offlineGuard.recordConsoleError(
    'provider failed https://api.x.ai/v1/responses?ticket=private',
  );
  assert.deepEqual(offlineGuard.failures, [
    'requestfailed: GET https://analytics.invalid (blocked token=<redacted>)',
    'console: provider failed https://api.x.ai',
  ]);
});

test('release server environments contain no case-insensitive Windows aliases', async () => {
  const { createReleaseServerEnvironment } = await import(
    '../e2e/aisy-learner-release-safety.js'
  );
  const environment = createReleaseServerEnvironment({}, {
    PATH: 'preferred-path',
    Path: 'ambiguous-path',
    SystemRoot: 'preferred-system-root',
    SYSTEMROOT: 'ambiguous-system-root',
    WINDIR: 'preferred-windir',
    windir: 'ambiguous-windir',
    ComSpec: 'preferred-comspec',
    COMSPEC: 'ambiguous-comspec',
  });
  const names = Object.keys(environment);
  assert.equal(new Set(names.map((name) => name.toUpperCase())).size, names.length,
    'the strict Windows Job environment block must never receive case-insensitive duplicates');
  assert.equal(environment.PATH, 'preferred-path');
  assert.equal(environment.SystemRoot, 'preferred-system-root');
  assert.equal(environment.WINDIR, 'preferred-windir');
  assert.equal(environment.ComSpec, 'preferred-comspec');
});

test('canonical release environment starts through the real Windows Job boundary', {
  skip: process.platform !== 'win32',
}, async () => {
  const { createReleaseServerEnvironment } = await import(
    '../e2e/aisy-learner-release-safety.js'
  );
  const { runBoundedReleaseCommand } = await import('../scripts/release-command-supervisor.js');
  const controlRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-release-env-job-'));
  try {
    const result = await runBoundedReleaseCommand(
      process.execPath,
      ['--input-type=module', '-e', 'process.exit(0)'],
      {
        commandLabel: 'canonical release environment Windows Job probe',
        env: createReleaseServerEnvironment({}),
        hardTimeoutMs: 5_000,
        killGraceMs: 1_000,
        terminateGraceMs: 1_000,
        windowsControlRoot: controlRoot,
      },
    );
    assert.equal(result.status, 0);
  } finally {
    await fs.rm(controlRoot, { force: true, recursive: true });
  }
});

test('release server children ignore hostile app and Node configuration from the owner shell', async () => {
  const { createReleaseServerEnvironment } = await import(
    '../e2e/aisy-learner-release-safety.js'
  );
  const probeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-release-env-'));
  const dataFile = path.join(probeDirectory, 'fixture.json');
  const playwrightPath = path.join(probeDirectory, 'playwright');
  const chromePath = path.join(probeDirectory, 'chrome');
  const childEnvironment = createReleaseServerEnvironment({
    RELEASE_ENV_PROBE: 'ready',
    EASYBOOST_DISABLE_DOTENV: 'false',
    NODE_ENV: 'test',
    PORT: '4321',
    APP_URL: 'http://127.0.0.1:4321',
    DATABASE_PROVIDER: 'file',
    DATA_FILE: dataFile,
    JWT_SECRET: 'release-fixture-secret-with-at-least-32-characters',
    ADAPTIVE_LEARNING_ENABLED: 'true',
  }, {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: playwrightPath,
    CHROME_PATH: chromePath,
    NODE_OPTIONS: '--no-warnings',
    VK_ID_MODE: 'live',
    VK_ID_APP_ID: '12345',
    VK_ID_REDIRECT_URI: 'https://production.example/api/v1/auth/vk/callback',
    VK_ID_LOCAL_SUBJECT: 'hostile-owner',
    VK_ID_PROVIDER_TIMEOUT_MS: '30000',
    API_ACCEPT_LEGACY_PATHS: 'false',
    DATABASE_PROVIDER: 'postgres',
    DATABASE_URL: 'postgresql://owner-shell.invalid/easyboost',
    DATA_FILE: 'owner-shell.json',
    JWT_SECRET: 'owner-shell-secret-with-at-least-32-characters',
    SESSION_DAYS: '90',
    ANONYMOUS_REQUESTS_PER_15_MINUTES: '10',
    ADAPTIVE_LEARNING_ENABLED: 'false',
    MONITORING_TOKEN: 'owner-shell-monitoring-token-with-32-characters',
    TELEGRAM_BOT_TOKEN: 'owner-shell-telegram-token',
    ADMIN_TELEGRAM_ID: '123456789',
    XAI_ENABLED: 'true',
    XAI_MODEL: 'owner-shell-model-latest',
    AI_TIMEOUT_MS: '120000',
    AI_MAX_CONCURRENT_REQUESTS: '64',
    GROQ_ENABLED: 'true',
    GROQ_MODEL: 'owner-shell-groq-model',
    VOICE_TUTOR_ENABLED: 'true',
    VOICE_TUTOR_COST_MICROUSD_PER_MINUTE: '9999999',
    XAI_VOICE_MODEL: 'grok-voice-owner-shell-latest',
    XAI_VOICE_NAME: 'owner_shell_voice',
    STT_TIMEOUT_MS: '120000',
  });

  try {
    await fs.writeFile(path.join(probeDirectory, '.env'), [
      'SESSION_DAYS=90',
      'API_ACCEPT_LEGACY_PATHS=false',
      'AI_MAX_CONCURRENT_REQUESTS=64',
      'VK_ID_PROVIDER_TIMEOUT_MS=30000',
    ].join('\n'), 'utf8');
    const configProbe = spawnSync(process.execPath, ['--input-type=module', '-e', [
      `const {config}=await import(${JSON.stringify(new URL('../config.js', import.meta.url).href)});`,
      'process.stdout.write(`CONFIG_PROBE:${JSON.stringify({',
      'nodeEnv:config.nodeEnv,port:config.port,sessionDays:config.sessionDays,',
      'anonymousRate:config.security.anonymousRequestsPer15Minutes,',
      'acceptLegacyPaths:config.api.acceptLegacyPaths,',
      'databaseProvider:config.database.provider,databaseUrl:config.database.url,',
      'databaseFile:config.database.file,adaptiveEnabled:config.adaptiveLearning.enabled,',
      'vkMode:config.vkId.mode,vkTimeout:config.vkId.providerTimeoutMs,',
      'xaiEnabled:config.ai.xaiEnabled,xaiModel:config.ai.xaiModel,',
      'aiTimeout:config.ai.timeoutMs,aiConcurrency:config.ai.maxConcurrentRequests,',
      'groqEnabled:config.ai.groqEnabled,groqModel:config.ai.groqModel,',
      'voiceEnabled:config.voiceTutor.enabled,voiceCost:config.voiceTutor.costMicrousdPerMinute,',
      'voiceModel:config.voiceTutor.model,voiceName:config.voiceTutor.voice,',
      'sttTimeout:config.ai.sttTimeoutMs,monitoringToken:config.monitoring.token,',
      'telegramToken:config.telegram.token,',
      '})}`);',
    ].join('')], {
      cwd: probeDirectory,
      encoding: 'utf8',
      env: childEnvironment,
      timeout: 5_000,
    });
    assert.equal(configProbe.status, 0,
      `real config must load from explicit test overrides only\n${configProbe.stdout}\n${configProbe.stderr}`);
    const observed = JSON.parse(configProbe.stdout.match(/CONFIG_PROBE:(\{.*\})/u)?.[1] ?? 'null');
    assert.deepEqual(observed, {
      nodeEnv: 'test',
      port: 4321,
      sessionDays: 30,
      anonymousRate: 300,
      acceptLegacyPaths: true,
      databaseProvider: 'file',
      databaseUrl: '',
      databaseFile: dataFile,
      adaptiveEnabled: true,
      vkMode: 'disabled',
      vkTimeout: 10_000,
      xaiEnabled: false,
      xaiModel: 'grok-4.5',
      aiTimeout: 25_000,
      aiConcurrency: 4,
      groqEnabled: false,
      groqModel: 'llama-3.3-70b-versatile',
      voiceEnabled: false,
      voiceCost: 50_000,
      voiceModel: '',
      voiceName: '',
      sttTimeout: 30_000,
      monitoringToken: '',
      telegramToken: '',
    });
    assert.equal(childEnvironment.EASYBOOST_DISABLE_DOTENV, 'true',
      'release server environments must reserve an explicit dotenv opt-out');
    assert.equal(childEnvironment.PLAYWRIGHT_BROWSERS_PATH, playwrightPath);
    assert.equal(childEnvironment.CHROME_PATH, chromePath);
    for (const key of [
      'NODE_OPTIONS', 'API_ACCEPT_LEGACY_PATHS', 'DATABASE_URL', 'SESSION_DAYS',
      'ANONYMOUS_REQUESTS_PER_15_MINUTES', 'AI_TIMEOUT_MS', 'AI_MAX_CONCURRENT_REQUESTS',
      'XAI_MODEL', 'GROQ_MODEL', 'VOICE_TUTOR_COST_MICROUSD_PER_MINUTE',
      'XAI_VOICE_MODEL', 'XAI_VOICE_NAME', 'STT_TIMEOUT_MS', 'VK_ID_LOCAL_SUBJECT',
      'VK_ID_PROVIDER_TIMEOUT_MS',
    ]) assert.equal(childEnvironment[key], undefined, `${key} must not be inherited`);

    const scalarProbe = (environment) => spawnSync(process.execPath, ['--input-type=module', '-e', [
      `const {config}=await import(${JSON.stringify(new URL('../config.js', import.meta.url).href)});`,
      'process.stdout.write(String(config.sessionDays));',
    ].join('')], {
      cwd: probeDirectory,
      encoding: 'utf8',
      env: environment,
      timeout: 5_000,
    });
    const ordinaryEnvironment = { ...childEnvironment };
    delete ordinaryEnvironment.EASYBOOST_DISABLE_DOTENV;
    const ordinaryProbe = scalarProbe(ordinaryEnvironment);
    assert.equal(ordinaryProbe.status, 0, ordinaryProbe.stderr);
    assert.equal(ordinaryProbe.stdout, '90',
      'ordinary runtime must continue loading its cwd .env by default');
    for (const recognizedFalse of ['false', '0']) {
      const falseProbe = scalarProbe({
        ...childEnvironment,
        EASYBOOST_DISABLE_DOTENV: recognizedFalse,
      });
      assert.equal(falseProbe.status, 0, falseProbe.stderr);
      assert.equal(falseProbe.stdout, '90');
    }
    const numericTrueProbe = scalarProbe({
      ...childEnvironment,
      EASYBOOST_DISABLE_DOTENV: '1',
    });
    assert.equal(numericTrueProbe.status, 0, numericTrueProbe.stderr);
    assert.equal(numericTrueProbe.stdout, '30');

    const invalidProbe = scalarProbe({
      ...childEnvironment,
      EASYBOOST_DISABLE_DOTENV: 'yes',
    });
    assert.notEqual(invalidProbe.status, 0);
    assert.match(invalidProbe.stderr,
      /EASYBOOST_DISABLE_DOTENV must be true, false, 1 or 0/u);
  } finally {
    await fs.rm(probeDirectory, { recursive: true, force: true });
  }
});

test('canonical release server children strip inherited live provider configuration before startup', async () => {
  const { createReleaseServerEnvironment } = await import(
    '../e2e/aisy-learner-release-safety.js'
  );
  const childEnvironment = createReleaseServerEnvironment({
    RELEASE_ENV_PROBE: 'ready',
    NODE_ENV: 'test',
    PORT: '4321',
    APP_URL: 'http://127.0.0.1:4321',
    DATABASE_PROVIDER: 'file',
    DATA_FILE: 'performance-fixture.json',
    JWT_SECRET: 'performance-fixture-secret-with-at-least-32-characters',
    ADAPTIVE_LEARNING_ENABLED: 'true',
  }, {
    ...process.env,
    TELEGRAM_BOT_TOKEN: 'live-looking-telegram-token',
    ADMIN_TELEGRAM_ID: '123456789',
    MONITORING_TOKEN: 'live-looking-monitoring-token-with-32-characters',
    XAI_ENABLED: 'true',
    XAI_API_KEY: 'live-looking-xai-key',
    XAI_API_URL: 'https://api.x.ai/v1/chat/completions',
    XAI_RULE_SEARCH_URL: 'https://api.x.ai/v1/rule-search',
    XAI_VOICE_REALTIME_URL: 'wss://api.x.ai/v1/realtime',
    GROQ_ENABLED: 'true',
    GROQ_API_KEY: 'live-looking-groq-key',
    GROQ_API_URL: 'https://api.groq.com/openai/v1/chat/completions',
    AZURE_SPEECH_KEY: 'live-looking-azure-key',
    AZURE_SPEECH_REGION: 'westeurope',
    VOICE_TUTOR_ENABLED: 'true',
    VOICE_TUTOR_RULE_SEARCH_ENABLED: 'true',
    SPEAKING_PRONUNCIATION_ENABLED: 'true',
  });
  const probeKeys = [
    'RELEASE_ENV_PROBE', 'NODE_ENV', 'PORT', 'APP_URL', 'DATABASE_PROVIDER', 'DATA_FILE',
    'JWT_SECRET', 'ADAPTIVE_LEARNING_ENABLED', 'EASYBOOST_DISABLE_DOTENV',
    'TELEGRAM_BOT_TOKEN', 'ADMIN_TELEGRAM_ID', 'MONITORING_TOKEN',
    'XAI_ENABLED', 'XAI_API_KEY', 'XAI_API_URL',
    'XAI_RULE_SEARCH_URL', 'XAI_VOICE_REALTIME_URL',
    'GROQ_ENABLED', 'GROQ_API_KEY', 'GROQ_API_URL',
    'AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION',
    'VOICE_TUTOR_ENABLED', 'VOICE_TUTOR_RULE_SEARCH_ENABLED',
    'SPEAKING_PRONUNCIATION_ENABLED',
  ];
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', [
    `const keys=${JSON.stringify(probeKeys)};`,
    'process.stdout.write(JSON.stringify(Object.fromEntries(keys.map((key)=>[key,process.env[key]??null]))));',
  ].join('')], {
    encoding: 'utf8', env: childEnvironment, timeout: 5_000,
  });
  assert.equal(probe.status, 0, `environment probe failed\n${probe.stderr}`);
  assert.deepEqual(JSON.parse(probe.stdout), {
    RELEASE_ENV_PROBE: 'ready',
    NODE_ENV: 'test',
    PORT: '4321',
    APP_URL: 'http://127.0.0.1:4321',
    DATABASE_PROVIDER: 'file',
    DATA_FILE: 'performance-fixture.json',
    JWT_SECRET: 'performance-fixture-secret-with-at-least-32-characters',
    ADAPTIVE_LEARNING_ENABLED: 'true',
    EASYBOOST_DISABLE_DOTENV: 'true',
    TELEGRAM_BOT_TOKEN: '',
    ADMIN_TELEGRAM_ID: '',
    MONITORING_TOKEN: '',
    XAI_ENABLED: 'false',
    XAI_API_KEY: '',
    XAI_API_URL: 'http://127.0.0.1:9/provider-disabled',
    XAI_RULE_SEARCH_URL: 'http://127.0.0.1:9/provider-disabled',
    XAI_VOICE_REALTIME_URL: 'ws://127.0.0.1:9/provider-disabled',
    GROQ_ENABLED: 'false',
    GROQ_API_KEY: '',
    GROQ_API_URL: 'http://127.0.0.1:9/provider-disabled',
    AZURE_SPEECH_KEY: '',
    AZURE_SPEECH_REGION: '',
    VOICE_TUTOR_ENABLED: 'false',
    VOICE_TUTOR_RULE_SEARCH_ENABLED: 'false',
    SPEAKING_PRONUNCIATION_ENABLED: 'false',
  });

  assert.match(releaseRunner,
    /import \{ createReleaseServerEnvironment \} from '\.\.\/e2e\/aisy-learner-release-safety\.js';/u);
  assert.match(releaseRunner,
    /import \{ runBoundedReleaseCommand \} from '\.\/release-command-supervisor\.js';/u);
  const releaseSpawn = releaseRunner.slice(
    releaseRunner.indexOf('function run(file'), releaseRunner.indexOf('export async function runAisyReleaseE2e'),
  );
  assert.match(releaseSpawn,
    /let environment = createReleaseServerEnvironment\(\{\}\);[\s\S]*let command = process\.execPath;[\s\S]*let args = \[file\];/u,
    'every canonical release inventory entry must start from a fail-closed child environment');
  assert.match(releaseSpawn,
    /runBoundedReleaseCommand\(command, args,[\s\S]*hardTimeoutMs:\s*AISY_RELEASE_E2E_CHILD_TIMEOUT_MS[\s\S]*env:\s*environment[\s\S]*stdio:\s*'inherit'/u,
    'every canonical release inventory entry must receive the fail-closed child environment');
  assert.equal(createReleaseServerEnvironment({}).EASYBOOST_DISABLE_DOTENV, 'true',
    'the canonical runner helper call must disable cwd dotenv loading');
  assert.doesNotMatch(releaseRunner, /child\.once\(['"](?:exit|error)['"]/u,
    'canonical release children must have one bounded close/reap lifecycle, not an unbounded event promise');

  assert.match(performanceE2e,
    /import \{ createReleaseServerEnvironment \} from '\.\/aisy-learner-release-safety\.js';/u);
  const performanceServerSpawn = performanceE2e.slice(
    performanceE2e.indexOf('child = spawn'), performanceE2e.indexOf("child.stdout.on('data'"),
  );
  assert.match(performanceServerSpawn,
    /env:\s*createReleaseServerEnvironment\(\{[\s\S]*NODE_ENV:\s*'test'[\s\S]*PORT:\s*String\(port\)[\s\S]*APP_URL:\s*baseUrl[\s\S]*DATABASE_PROVIDER:\s*'file'[\s\S]*DATA_FILE:\s*dataFile[\s\S]*JWT_SECRET:\s*jwtSecret[\s\S]*ADAPTIVE_LEARNING_ENABLED:\s*'true'[\s\S]*\}\)/u,
    'the separately launched performance server must sanitize inherited providers and retain its local fixture');
  assert.doesNotMatch(performanceServerSpawn, /env:\s*\{\s*\.\.\.process\.env/u);

  assert.match(egeWrittenE2e,
    /import \{ createReleaseServerEnvironment \} from '\.\/aisy-learner-release-safety\.js';/u);
  const egeServerSpawn = egeWrittenE2e.slice(
    egeWrittenE2e.indexOf('child = spawn'), egeWrittenE2e.indexOf("child.stdout.on('data'"),
  );
  assert.match(egeServerSpawn,
    /env:\s*createReleaseServerEnvironment\(\{[\s\S]*NODE_ENV:\s*'test'[\s\S]*\}\)/u,
    'a direct EGE written run must sanitize inherited providers before its server starts');
  assert.doesNotMatch(egeServerSpawn, /env:\s*\{\s*\.\.\.process\.env/u);
});

test('the Aisy UX operations contract keeps release evidence bounded and local', async () => {
  const operations = await fs.readFile(new URL('../docs/AISY_UX_OPERATIONS.md', import.meta.url), 'utf8');
  for (const requirement of [
    /Сегодня.*Практика.*ЕГЭ.*Прогресс.*Профиль/su,
    /150\s*КБ/iu,
    /reload.*offline.*cross-tab/isu,
    /npm run test:e2e:aisy/u,
    /npm run test:e2e:performance/u,
    /npm run security:secrets/u,
    /npm run security:history/u,
    /git diff --check/u,
    /не.*deploy|deploy.*не/iu,
    /не содержит.*username|username.*не/iu,
  ]) assert.match(operations, requirement);
});
