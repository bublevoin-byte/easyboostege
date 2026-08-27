import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const rawSource = await fs.readFile(new URL('../public/voice-tutor.js', import.meta.url), 'utf8');
const executableSource = `${rawSource
  .replace(/^import[\s\S]*?from '[^']+';\r?\n/gmu, '')
  .replace(/^export \{[\s\S]*?\} from '[^']+';\r?\n/gmu, '')
  .replace(/^export /gmu, '')
  .replace(/if \(browser\.document\) ensureSheet\(\);\s*$/u, '')}
globalThis.__voiceTutorHarness={
  advanceTutorSession,
  closeSheet,
  discoverMissingRule,
  requestClarification,
  submitClarification,
  submitTutorReport,
  submitTutorStep,
  switchToFallback,
  setSession(value){currentSession=value},
  setSessionOperation(value){sessionOperation=value},
};`;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, reject, resolve };
}

class FakeClassList {
  constructor(values = []) { this.values = new Set(values); }
  add(...values) { values.forEach((value) => this.values.add(value)); }
  contains(value) { return this.values.has(value); }
  remove(...values) { values.forEach((value) => this.values.delete(value)); }
  toggle(value, force) {
    const active = force ?? !this.values.has(value);
    if (active) this.values.add(value); else this.values.delete(value);
    return active;
  }
}

function fakeElement(id = '') {
  const attributes = new Map();
  const listeners = new Map();
  return {
    id,
    attributes,
    classList: new FakeClassList(),
    dataset: {},
    disabled: false,
    hidden: false,
    innerHTML: '',
    textContent: '',
    value: '',
    append() {},
    appendChild() {},
    addEventListener(type, listener) { listeners.set(type, listener); },
    focus() {},
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
    replaceChildren() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
  };
}

function harness() {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement(id));
    return elements.get(id);
  };
  element('voiceTutorSheet').classList.add('open');
  const answer = element('voiceTutorAnswer');
  const input = element('voiceTutorInput');
  const submit = element('voiceTutorSubmit');
  answer.querySelector = (selector) => selector === 'button[type="submit"]' ? submit : null;
  answer.querySelectorAll = () => [input, submit];
  const quick = element('voiceTutorQuick');
  const clarify = element('voiceTutorClarify');
  const explain = element('voiceTutorExplainDifferently');
  quick.querySelectorAll = () => [clarify, explain];
  const status = element('voiceTutorStatus');
  const state = element('voiceTutorState');
  const calls = [];
  const pending = deferred();
  const api = {
    messageFor(error) { return error?.message || 'request failed'; },
    post(path, body) {
      calls.push({ body, path });
      return pending.promise;
    },
  };
  const document = {
    activeElement: null,
    body: fakeElement('body'),
    createElement: (tag) => fakeElement(tag),
    getElementById: element,
    querySelector: (selector) => selector === '.vtQuick' ? quick : null,
    querySelectorAll: () => [],
  };
  const context = {
    AbortController,
    Blob,
    browserRealtimeTransport: () => ({}),
    canStartVoiceTutor: () => true,
    clearInterval,
    clearTimeout,
    console,
    crypto: { randomUUID: () => 'test-operation-key' },
    document,
    eventForVoiceTutorState: () => ({ type: 'diagnosis_complete', answer: 'because' }),
    prepareVoiceTutorContextResult: () => null,
    setInterval,
    setTimeout,
    URL,
    voiceTutorButton: () => '',
    voiceTutorResultSlot: () => '',
    voiceTutorSlotId: () => '',
  };
  const sandbox = vm.createContext(context);
  vm.runInContext(executableSource, sandbox, { filename: 'voice-tutor.js' });
  sandbox.__voiceTutorHarness.setSession({
    mode: 'local',
    nonce: 'nonce-old',
    session: { id: 'session-old', state: 'diagnose' },
  });
  sandbox.__voiceTutorHarness.setSessionOperation(1);
  // Configure inside the module context after evaluation so the production api() seam is exercised.
  sandbox.__api = api;
  vm.runInContext('configureVoiceTutor({api:globalThis.__api})', sandbox);
  return { answer, api, calls, clarify, context: sandbox, explain, input, pending, quick, state, status, submit };
}

test('Voice Tutor serializes a double submit for the same session nonce and exposes one busy interaction', async () => {
  const { answer, calls, clarify, context, explain, input, pending, quick, submit } = harness();
  input.value = 'because';
  const event = { preventDefault() {} };
  const first = context.__voiceTutorHarness.submitTutorStep(event);
  const second = context.__voiceTutorHarness.submitTutorStep(event);
  await Promise.resolve();

  assert.equal(calls.length, 1, 'double Enter must create only one same-nonce advance request');
  assert.equal(input.disabled, true);
  assert.equal(submit.disabled, true);
  assert.equal(clarify.disabled, true);
  assert.equal(explain.disabled, true);
  assert.equal(answer.getAttribute('aria-busy'), 'true');
  assert.equal(quick.getAttribute('aria-busy'), 'true');

  pending.reject(Object.assign(new Error('offline'), { code: 'NETWORK_ERROR' }));
  await Promise.allSettled([first, second]);
  assert.equal(input.disabled, false);
  assert.equal(submit.disabled, false);
  assert.equal(clarify.disabled, false);
  assert.equal(explain.disabled, false);
  assert.equal(answer.getAttribute('aria-busy'), 'false');
  assert.equal(quick.getAttribute('aria-busy'), 'false');
});

test('a rejected old interaction cannot render an error or clear input after close and reopen', async () => {
  const { context, input, pending, state, status } = harness();
  input.value = 'old question';
  const old = context.__voiceTutorHarness.submitClarification();
  await Promise.resolve();

  await context.__voiceTutorHarness.closeSheet();
  context.document.getElementById('voiceTutorSheet').classList.add('open');
  context.__voiceTutorHarness.setSession({
    mode: 'local',
    nonce: 'nonce-new',
    session: { id: 'session-new', state: 'diagnose' },
  });
  input.value = 'new-session answer';
  status.dataset.state = 'voice';
  state.textContent = 'Новая сессия готова';
  pending.reject(Object.assign(new Error('late offline'), { code: 'NETWORK_ERROR' }));
  await Promise.allSettled([old]);

  assert.equal(status.dataset.state, 'voice');
  assert.equal(state.textContent, 'Новая сессия готова');
  assert.equal(input.value, 'new-session answer');
});

test('a successful old clarification cannot clear the reopened session input', async () => {
  const { context, input, pending } = harness();
  input.value = 'old question';
  const old = context.__voiceTutorHarness.submitClarification();
  await Promise.resolve();

  await context.__voiceTutorHarness.closeSheet();
  context.document.getElementById('voiceTutorSheet').classList.add('open');
  context.__voiceTutorHarness.setSession({
    mode: 'local',
    nonce: 'nonce-new',
    session: { id: 'session-new', state: 'diagnose' },
  });
  input.value = 'new-session answer';
  pending.resolve({ nonce: 'nonce-after-old-success' });
  await old;

  assert.equal(input.value, 'new-session answer');
});

test('Voice Tutor report is single-flight and a late rejection cannot alter a reopened session', async () => {
  const { calls, context, pending, state, status } = harness();
  const reason = context.document.getElementById('voiceTutorReportReason');
  const report = context.document.getElementById('voiceTutorReport');
  reason.value = 'technical_issue';

  const first = context.__voiceTutorHarness.submitTutorReport();
  const duplicate = context.__voiceTutorHarness.submitTutorReport();
  await Promise.resolve();

  assert.equal(calls.length, 1, 'double click must create only one report for the current session');
  assert.equal(calls[0].body.session_id, 'session-old');
  assert.equal(reason.disabled, true);
  assert.equal(report.disabled, true);

  await context.__voiceTutorHarness.closeSheet();
  context.document.getElementById('voiceTutorSheet').classList.add('open');
  context.__voiceTutorHarness.setSession({
    mode: 'local',
    nonce: 'nonce-new',
    session: { id: 'session-new', state: 'diagnose' },
  });
  status.dataset.state = 'voice';
  state.textContent = 'Новая сессия готова';
  pending.reject(Object.assign(new Error('late report failure'), { code: 'NETWORK_ERROR' }));
  await Promise.allSettled([first, duplicate]);

  assert.equal(status.dataset.state, 'voice');
  assert.equal(state.textContent, 'Новая сессия готова');
  assert.equal(reason.disabled, false);
  assert.equal(report.disabled, false);
});

function nextTutorResult() {
  return {
    mode: 'text',
    nonce: 'nonce-next',
    session: { id: 'session-old', state: 'explain', expires_at: '2099-01-01T00:00:00.000Z' },
    capsule: {
      skill: { label: 'Grammar' },
      item: { prompt: 'Choose the form', context: null },
      rule: { explanation: 'Новая инструкция шага' },
      checks: {},
    },
    voice_tutor: { daily_remaining_seconds: 240, monthly_remaining_seconds: 1_200 },
  };
}

for (const outcome of ['success', 'error']) {
  test(`late same-session report ${outcome} cannot replace the next pedagogical step`, async () => {
    const { api, context, state, status } = harness();
    const reportPending = deferred();
    context.document.getElementById('voiceTutorReportReason').value = 'technical_issue';
    api.post = (path, body) => {
      if (path === '/api/v1/voice-tutor/reports') return reportPending.promise;
      if (path.endsWith('/events')) return Promise.resolve(nextTutorResult());
      throw new Error(`unexpected path: ${path} ${JSON.stringify(body)}`);
    };

    const reportRequest = context.__voiceTutorHarness.submitTutorReport();
    await context.__voiceTutorHarness.advanceTutorSession({ type: 'diagnosis_complete', answer: 'because' });
    const nextState = state.textContent;
    const nextVisualState = status.dataset.state;
    assert.equal(nextState, 'Новая инструкция шага');

    if (outcome === 'success') reportPending.resolve({ ok: true });
    else reportPending.reject(Object.assign(new Error('report offline'), { code: 'NETWORK_ERROR' }));
    await Promise.allSettled([reportRequest]);

    assert.equal(state.textContent, nextState);
    assert.equal(status.dataset.state, nextVisualState);
    const reportStatus = context.document.getElementById('voiceTutorReportStatus');
    assert.equal(reportStatus.dataset.state, outcome);
  });
}

test('a late fallback rejection cannot replace a newer nonce from the same session', async () => {
  const { api, context, state, status } = harness();
  const fallbackPending = deferred();
  context.__voiceTutorHarness.setSession({
    mode: 'voice',
    nonce: 'nonce-old',
    session: { id: 'session-old', state: 'diagnose' },
  });
  api.post = (path, body) => {
    if (path.endsWith('/fallback')) return fallbackPending.promise;
    if (path.endsWith('/events')) return Promise.resolve({ ...nextTutorResult(), mode: 'voice' });
    throw new Error(`unexpected path: ${path} ${JSON.stringify(body)}`);
  };

  const fallback = context.__voiceTutorHarness.switchToFallback('microphone_unavailable');
  await Promise.resolve();
  await context.__voiceTutorHarness.advanceTutorSession({ type: 'diagnosis_complete', answer: 'because' });
  const nextState = state.textContent;
  const nextVisualState = status.dataset.state;
  assert.equal(nextState, 'Новая инструкция шага');

  fallbackPending.reject(Object.assign(new Error('late fallback failure'), { code: 'NETWORK_ERROR' }));
  await Promise.allSettled([fallback]);

  assert.equal(state.textContent, nextState);
  assert.equal(status.dataset.state, nextVisualState);
});

for (const outcome of ['success', 'error']) {
  test(`stale rule-discovery ${outcome} cannot overwrite a newer nonce and blocks same-nonce advance`, async () => {
    const { api, calls, context, state, status } = harness();
    const discoveryPending = deferred();
    api.post = (path, body) => {
      calls.push({ body, path });
      if (path === '/api/v1/voice-tutor/rule-discoveries') return discoveryPending.promise;
      throw new Error(`unexpected competing request: ${path}`);
    };
    const discoveryResult = {
      mode: 'local', nonce: 'nonce-old', discovery_required: true,
      session: { id: 'session-old', state: 'diagnose' },
    };

    const discovery = context.__voiceTutorHarness.discoverMissingRule(discoveryResult, 1);
    const competingAdvance = await context.__voiceTutorHarness.advanceTutorSession({
      type: 'diagnosis_complete', answer: 'because',
    });
    assert.equal(competingAdvance, null, 'discovery owns the nonce until its result is resolved');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/api/v1/voice-tutor/rule-discoveries');

    context.__voiceTutorHarness.setSession({
      mode: 'local', nonce: 'nonce-next',
      session: { id: 'session-old', state: 'explain' },
    });
    state.textContent = 'Новая инструкция шага';
    status.dataset.state = 'text-fallback';
    if (outcome === 'success') discoveryPending.resolve({ provisional: true });
    else discoveryPending.reject(Object.assign(new Error('late discovery failure'), { code: 'NETWORK_ERROR' }));
    await Promise.allSettled([discovery]);

    assert.equal(state.textContent, 'Новая инструкция шага');
    assert.equal(status.dataset.state, 'text-fallback');
  });
}
