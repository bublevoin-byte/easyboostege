import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const [source, styles] = await Promise.all([
  fs.readFile(new URL('../public/screens/speaking.js', import.meta.url), 'utf8'),
  fs.readFile(new URL('../public/speaking.css', import.meta.url), 'utf8'),
]);

test('full Speaking screen is driven by the owner-bound server session and an honest final state', () => {
  assert.match(source, /createSpeakingFullBrowserFlow/u);
  assert.match(source, /S\.speakingFullSessionId/u);
  assert.match(source, /prepareCurrentAssets/u);
  assert.match(source, /Максимум: 20 баллов/u);
  const fullSection = source.slice(source.indexOf('function spExam'), source.indexOf('/* ---- фоновая'));
  assert.match(fullSection, /speFullEvaluate/u);
  assert.match(fullSection, /sessionMode:'full_section'/u);
  assert.match(fullSection, /full-sessions\/.*pronunciation-assessment/u);
  assert.match(fullSection, /assessmentRecordings/u);
  assert.match(fullSection, /примерн/u);
  assert.doesNotMatch(fullSection, /Оценка пока недоступна/u);
});

test('full Speaking controls cover local recording, technical recovery, eleven responses and submit', () => {
  assert.match(source, /speFullMicCheck/u);
  assert.match(source, /speFullBeginStage/u);
  assert.match(source, /speFullStartRecording/u);
  assert.match(source, /speFullStopRecording/u);
  assert.match(source, /speFullComplete\([^\n]+completed/u);
  assert.match(source, /speFullComplete\([^\n]+technical_issue/u);
  assert.match(source, /speFullComplete\([^\n]+skipped/u);
  assert.match(source, /speFullSubmit/u);
  assert.match(source, /speFullSubmit\(this\)/u);
  assert.match(source, /SPE_FULL_SUBMIT_KEY\|\|globalThis\.crypto\.randomUUID\(\)/u,
    'ambiguous submit retries reuse one session idempotency key');
  assert.match(source, /spe_full_submission_status[\s\S]*?aria-busy[\s\S]*?Повторить сдачу/u,
    'submission exposes persistent processing and recoverable retry states');
  assert.match(source, /completedResponses/u);
});

test('full Speaking preserves official prompts and renders the honest available breakdown', () => {
  const taskBody = source.slice(source.indexOf('function speTaskBody'), source.indexOf('function speFullProgress'));
  const startRecording = source.slice(
    source.indexOf('async function speFullStartRecording'),
    source.indexOf('async function speFullStopRecording'),
  );
  const dispose = source.slice(source.indexOf('function speFullDispose'), source.indexOf('function speFullPointerInvalid'));
  assert.match(taskBody, /phase==='preparing'[\s\S]*task\.supports\.map/u);
  assert.match(taskBody, /task\.taskType===3[\s\S]*phase==='ready'[\s\S]*Вопрос прозвучит/u);
  assert.match(source, /function speFullBeginStage[\s\S]*task\.taskType===3[\s\S]*speFullStartRecording/u);
  assert.match(startRecording, /await Promise\.resolve\(lPlayRaw/u);
  assert.ok(startRecording.indexOf('await Promise.resolve(lPlayRaw') < startRecording.indexOf('await flow.startRecording'));
  assert.doesNotMatch(taskBody, /speFullPlayQuestion|Повторить вопрос/u);
  assert.match(source, /item\.usedSeconds/u);
  assert.match(source, /result\.improvementPlan/u);
  assert.match(dispose, /lStop\(\)/u);
});

test('full Speaking runtime templates use semantic headings and token-owned Paper A styling', () => {
  const fullSection = source.slice(source.indexOf('function spExam'), source.indexOf('/* ---- фоновая'));
  const fullStyles = styles.slice(
    styles.indexOf('/* Ticket08 full-section classes are inserted below this anchor. */'),
    styles.indexOf('.speaking-route summary'),
  );

  assert.match(fullSection, /<h2\b/u);
  assert.match(fullSection, /<h3\b/u);
  assert.doesNotMatch(fullSection, /\bstyle=|#[0-9a-f]{3,8}\b|font-family:|box-shadow:|border-radius:/iu);
  assert.match(fullStyles, /var\(--aisy-/u);
  assert.doesNotMatch(fullStyles, /#[0-9a-f]{3,8}\b|rgba?\(|\b(?:Nunito|Manrope)\b/iu);
});

test('full Speaking serializes stage mutations and never loses an official timeout', () => {
  for (const action of ['BeginStage', 'StartRecording', 'StopRecording', 'Complete']) {
    const start = source.indexOf(`async function speFull${action}`);
    const end = source.indexOf('\nasync function ', start + 1);
    const body = source.slice(start, end < 0 ? source.length : end);
    assert.match(body, /speFullAcquireStage/u, `${action} uses the shared stage lock`);
    assert.match(body, /speFullStageCurrent/u, `${action} rejects a stale flow`);
  }
  assert.match(source, /function speFullStageSnapshot[\s\S]*sessionId[\s\S]*taskType[\s\S]*responseNumber[\s\S]*phase[\s\S]*stageDeadlineAt/u);
  assert.match(source, /function speFullStageMatches[\s\S]*current\.phase===snapshot\.phase[\s\S]*current\.stageDeadlineAt===snapshot\.stageDeadlineAt/u);
  assert.match(source, /function speFullReleaseStage[\s\S]*expiredStage=SPE_FULL_TIMEOUT_PENDING[\s\S]*speFullStageMatches\(expiredStage\)[\s\S]*speFullTimeout\(expiredStage\)/u);
  assert.match(source, /async function speFullTimeout[\s\S]*SPE_FULL_STAGE_ACTION[\s\S]*SPE_FULL_TIMEOUT_PENDING=snapshot/u);
  assert.match(source, /async function speFullBeginStage[\s\S]*return await speFullStartRecording\(null,lock\)/u,
    'the owner keeps the shared lock until nested recording startup settles');
  assert.match(source, /async function speFullTimeout[\s\S]*return await speFullComplete\([^\n]+null,lock\)/u,
    'the timeout owner keeps the shared lock until nested completion settles');
  assert.match(source, /setAttribute\('aria-label','Оставшееся время: '\+value\)/u);
});

test('full Speaking assessment is fail-closed before upload and has a status-only network retry', () => {
  const loader = source.slice(
    source.indexOf('async function speFullLoadAssessmentStatus'),
    source.indexOf('async function spUploadFullPronunciation'),
  );
  const retry = source.slice(
    source.indexOf('async function speFullRetryAssessmentStatus'),
    source.indexOf('async function speFullLoadAssessmentStatus'),
  );
  const evaluate = source.slice(
    source.indexOf('async function speFullEvaluate'),
    source.indexOf('function speFullFinal'),
  );

  assert.match(source, /SPE_RESTORED_WITHOUT_AUDIO\|\|!box/u);
  assert.match(source, /if\(!assessed&&!SPE_RESTORED_WITHOUT_AUDIO\)void speFullLoadAssessmentStatus/u);
  assert.match(source, /data-speaking-assessment-action="evaluate" data-assessment-ready="false"/u);
  assert.ok(loader.indexOf('speFullAssessmentRecordingReadiness') < loader.indexOf("apiGet('/api/v1/speaking/pronunciation-assessments/status')"),
    'secure local recording completeness is checked before the quota/provider request');
  assert.match(loader, /recordingReadiness\.ready[\s\S]*dataset\.state='quality'[\s\S]*speFullRetireAssessmentAction\(button\)/u);
  assert.match(loader, /provider\.available&&Number\(quota\.remainingSeconds\|\|0\)>=expected[\s\S]*speFullSetAssessmentReady\(button,true,false\)/u);
  assert.match(loader, /speFullAssessmentRetryMarkup\(\)/u);
  assert.match(source, /function speFullAssessmentRetryMarkup[\s\S]*speFullRetryAssessmentStatus\(this\)/u);
  assert.match(retry, /return speFullLoadAssessmentStatus\(result\)/u);
  assert.doesNotMatch(retry, /spUploadFullPronunciation|speFullEvaluate|SPE_FULL_UPLOAD_CACHE/u);
  assert.match(evaluate, /speFullAcquireEvaluation/u);
  assert.match(evaluate, /providerUnavailable\?speFullAssessmentRetryMarkup\(\):''/u);
  assert.match(evaluate, /if\(terminalQuota\)speFullRetireAssessmentAction\(btn\)/u);
  assert.match(evaluate, /finally\{speFullReleaseEvaluation\(assessmentLock\)\}/u);
  assert.match(source, /function speFullAcquireEvaluation[\s\S]*route\.querySelectorAll\('button'\)/u);
  assert.match(source, /function speFullRetireAssessmentAction[\s\S]*button\.hidden=true[\s\S]*spPromoteForwardAction\(\)/u);
  assert.match(source, /spBtn\('Новый вариант'[^\n]+data-speaking-forward/u);
});

test('full Speaking provider preflight retries safely and preserves the upload cache', async () => {
  const assessmentControls = source.slice(
    source.indexOf('function speFullAssessmentButton'),
    source.indexOf('async function spUploadFullPronunciation'),
  );
  const attributes = new Map();
  const evaluationButton = {
    dataset: {}, disabled: false, hidden: false,
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
  };
  const statusAttributes = new Map();
  const statusBox = {
    classList: { add() {} }, dataset: {}, innerHTML: '',
    setAttribute(name, value) { statusAttributes.set(name, String(value)); },
    removeAttribute(name) { statusAttributes.delete(name); },
  };
  const result = { assessment: { available: false }, taskResults: [] };
  const flow = { assessmentRecordings() { return []; } };
  const uploadCache = { sessionId: 'stable-session', items: { '1:1': { key: 'stable-key' } } };
  let statusCalls = 0;
  let forwardPromotions = 0;
  const context = vm.createContext({
    SPE_FLOW: flow,
    SPE_FULL_RESULT: result,
    SPE_RESTORED_WITHOUT_AUDIO: false,
    SPE_FULL_ASSESSMENT_READY: false,
    SPE_FULL_UPLOAD_CACHE: uploadCache,
    document: {
      querySelector() { return evaluationButton; },
      getElementById(id) { return id === 'spe_full_assessment_status' ? statusBox : null; },
    },
    speFullAssessmentRecordingReadiness() { return { ready: true, expectedSeconds: 9 }; },
    async apiGet() {
      statusCalls += 1;
      return statusCalls === 1
        ? { provider: { available: false }, quota: { remainingSeconds: 3_600 } }
        : { provider: { available: true }, quota: { remainingSeconds: 3_600 } };
    },
    spFmt(value) { return String(value); },
    spPromoteForwardAction() { forwardPromotions += 1; },
  });
  vm.runInContext(`${assessmentControls}\nglobalThis.__assessmentApi = { load: speFullLoadAssessmentStatus, retry: speFullRetryAssessmentStatus };`, context);

  assert.equal(await context.__assessmentApi.load(result), false);
  assert.equal(statusBox.dataset.state, 'provider-unavailable');
  assert.match(statusBox.innerHTML, /aisy-button--secondary[\s\S]*Повторить проверку доступности/u);
  assert.equal(evaluationButton.disabled, true);
  assert.equal(evaluationButton.dataset.assessmentReady, 'false');
  assert.strictEqual(context.SPE_FULL_UPLOAD_CACHE, uploadCache);

  const retryButton = {
    dataset: {}, disabled: false,
    setAttribute() {}, removeAttribute() {},
  };
  assert.equal(await context.__assessmentApi.retry(retryButton), true);
  assert.equal(statusBox.dataset.state, 'ready');
  assert.equal(evaluationButton.disabled, false);
  assert.equal(evaluationButton.dataset.assessmentReady, 'true');
  assert.equal(context.SPE_FULL_ASSESSMENT_READY, true);
  assert.strictEqual(context.SPE_FULL_UPLOAD_CACHE, uploadCache);
  assert.equal(uploadCache.items['1:1'].key, 'stable-key');

  context.speFullAssessmentRecordingReadiness = () => ({ ready: false, expectedSeconds: 0 });
  evaluationButton.hidden = false;
  assert.equal(await context.__assessmentApi.load(result), false);
  assert.equal(statusBox.dataset.state, 'quality');
  assert.equal(evaluationButton.hidden, true);
  assert.equal(forwardPromotions, 1);
  assert.equal(statusCalls, 2, 'terminal quality is decided before provider/quota preflight');
  assert.strictEqual(context.SPE_FULL_UPLOAD_CACHE, uploadCache);
});

test('full Speaking only marks restored audio unavailable when audio was actually lost', () => {
  const definition = /function speFullRestoreLostAudio\(session\)\{[^\n]+\}/u.exec(source)?.[0];
  assert.ok(definition, 'the restore-loss classifier exists');
  const lostAudio = vm.runInNewContext(`(${definition})`);
  const pending = { status: 'in_progress', phase: 'preparing', progress: [
    { responses: [{ status: 'pending' }] },
  ] };
  assert.equal(lostAudio(pending), false);
  assert.equal(lostAudio({ ...pending, phase: 'recording' }), true);
  assert.equal(lostAudio({
    ...pending,
    phase: 'ready',
    progress: [{ responses: [{ status: 'completed' }] }],
  }), true);
  assert.equal(lostAudio({
    ...pending,
    phase: 'ready',
    progress: [{ responses: [{ status: 'skipped' }, { status: 'technical_issue' }] }],
  }), false);
});

test('full Speaking recording readiness rejects missing secure audio before provider preflight', () => {
  const definition = /function speFullAssessmentRecordingReadiness\(result,recordings\)\{[^\n]+\}/u.exec(source)?.[0];
  assert.ok(definition, 'the pure recording readiness guard exists');
  const readiness = vm.runInNewContext(`(${definition})`);
  const result = { taskResults: [{ taskType: 2, recordingStatus: 'completed' }] };
  const recordings = [1, 2, 3, 4].map((responseNumber) => ({
    taskType: 2,
    responseNumber,
    blob: {},
    durationSeconds: 1.2,
    sha256: 'a'.repeat(64),
  }));

  assert.deepEqual(
    JSON.parse(JSON.stringify(readiness(result, recordings))),
    { ready: true, expectedSeconds: 8, reason: null },
  );
  assert.equal(readiness(result, recordings.slice(0, 3)).ready, false);
  assert.equal(readiness(result, recordings.map((item, index) => ({
    ...item,
    sha256: index === 2 ? null : item.sha256,
  }))).ready, false);
  assert.equal(readiness({ taskResults: [{ taskType: 2, recordingStatus: 'skipped' }] }, []).ready, false);
});
