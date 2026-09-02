import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

function eventTarget(target = {}) {
  const listeners = new Map();
  return Object.assign(target, {
    addEventListener(type, listener) {
      const current = listeners.get(type) ?? [];
      current.push(listener);
      listeners.set(type, current);
    },
    dispatch(type, detail = {}) {
      const event = { type, ...detail };
      for (const listener of listeners.get(type) ?? []) listener.call(this, event);
      return event;
    },
    dispatchEvent(event) {
      return this.dispatch(event.type, event);
    },
  });
}

class FakeElement {
  constructor(id, tagName = 'div') {
    this.attributes = new Map();
    this.disabled = false;
    this.hidden = false;
    this.id = id;
    this.parent = null;
    this.tagName = tagName.toUpperCase();
    this.textContent = '';
    eventTarget(this);
  }

  closest(selector) {
    if (selector === '[hidden], [inert]') return this.hidden ? this : null;
    return null;
  }

  contains(element) {
    return element === this || element?.parent === this;
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  getClientRects() {
    return [{ width: 100, height: 44 }];
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  matches(selector) {
    if (selector === ':disabled') return this.disabled;
    return /button|input|textarea|select/u.test(selector) && this.tagName === 'BUTTON';
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
}

function worker(name, serviceWorker) {
  return eventTarget({
    messages: [],
    name,
    state: 'installed',
    postMessage(message) {
      this.messages.push(message);
      if (message.type === 'SKIP_WAITING') {
        serviceWorker.dispatch('message', {
          data: { type: 'WAITING_FOR_OTHER_TABS' },
          source: this,
        });
      }
    },
  });
}

async function startHarness({ href = 'https://easyboost.test/' } = {}) {
  const serviceWorker = eventTarget({ controller: null });
  const predecessor = worker('A', serviceWorker);
  predecessor.state = 'activated';
  serviceWorker.controller = predecessor;
  const generationB = worker('B', serviceWorker);
  const generationC = worker('C', serviceWorker);
  const registration = eventTarget({
    installing: null,
    waiting: generationB,
    update: async () => {},
  });
  serviceWorker.register = async () => registration;

  const elements = new Map();
  for (const [id, tag] of [
    ['pwa_update', 'section'],
    ['pwa_update_copy', 'p'],
    ['pwa_update_apply', 'button'],
    ['pwa_update_dismiss', 'button'],
  ]) elements.set(id, new FakeElement(id, tag));
  const notice = elements.get('pwa_update');
  const copy = elements.get('pwa_update_copy');
  const apply = elements.get('pwa_update_apply');
  const dismiss = elements.get('pwa_update_dismiss');
  notice.hidden = true;
  copy.textContent = 'Текущее задание не прервётся. Завершите шаг и обновите приложение.';
  apply.textContent = 'Обновить после задания';
  dismiss.textContent = 'Позже';
  apply.parent = notice;
  dismiss.parent = notice;

  const document = eventTarget({
    activeElement: null,
    body: new FakeElement('body', 'body'),
    documentElement: new FakeElement('html', 'html'),
    getElementById(id) { return elements.get(id) ?? null; },
    querySelector() { return null; },
  });
  for (const element of [...elements.values(), document.body, document.documentElement]) {
    element.ownerDocument = document;
  }
  document.activeElement = document.body;

  let intervalSequence = 0;
  const intervals = new Map();
  let reloads = 0;
  let locationHref = href;
  const replacements = [];
  const toastMessages = [];
  const window = eventTarget({
    clearInterval(id) { intervals.delete(id); },
    history: {
      state: null,
      replaceState(state, _title, next) {
        this.state = state;
        replacements.push(String(next));
        locationHref = new URL(String(next), locationHref).href;
        window.location.href = locationHref;
      },
    },
    location: { href: locationHref, reload() { reloads += 1; } },
    setInterval(callback) {
      intervalSequence += 1;
      intervals.set(intervalSequence, callback);
      return intervalSequence;
    },
  });
  class FakeCustomEvent {
    constructor(type, init = {}) {
      this.detail = init.detail;
      this.type = type;
    }
  }
  const source = (await fs.readFile(new URL('../public/pwa.js', import.meta.url), 'utf8'))
    .replace("import { toast } from './app.js';", '');
  vm.runInNewContext(source, {
    console,
    CustomEvent: FakeCustomEvent,
    document,
    HTMLElement: FakeElement,
    navigator: { serviceWorker },
    toast(message, duration) { toastMessages.push({ message, duration }); },
    URL,
    window,
  }, { filename: 'public/pwa.js' });
  window.dispatch('load');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return {
    apply,
    copy,
    dismiss,
    generationB,
    generationC,
    intervals,
    notice,
    replacements,
    registration,
    locationHref: () => locationHref,
    reloads: () => reloads,
    serviceWorker,
    toastMessages,
  };
}

async function serviceWorkerFetchHarness() {
  const origin = 'https://aisy.example';
  const self = eventTarget({
    clients: {
      async matchAll() { return []; },
    },
    location: { origin },
    navigator: {},
    registration: { active: null },
  });
  const cache = {
    async addAll() {},
    async keys() { return []; },
    async match() { return null; },
    async put() {},
  };
  const caches = {
    async delete() { return true; },
    async keys() { return []; },
    async open() { return cache; },
  };
  const source = await fs.readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    caches,
    crypto: globalThis.crypto,
    fetch: async () => new Response('fresh network', {
      headers: { 'Cache-Control': 'no-store' },
    }),
    Headers,
    Request,
    Response,
    self,
    setTimeout,
    URL,
  }, { filename: 'public/service-worker.js' });

  return async function workerIntercepts(pathname) {
    const work = [];
    let response = null;
    self.dispatch('fetch', {
      request: new Request(`${origin}${pathname}`),
      respondWith(value) { response = Promise.resolve(value); },
      waitUntil(value) { work.push(Promise.resolve(value)); },
    });
    await Promise.allSettled([...work, ...(response ? [response] : [])]);
    return Boolean(response);
  };
}

test('a waiting update uses the in-frame live notice as its only notification surface', async () => {
  const harness = await startHarness();
  assert.equal(harness.notice.hidden, false);
  assert.deepEqual(harness.toastMessages, [],
    'a duplicate transient toast must not cover or intercept the learner task CTA');
});

test('only a tab that consented reloads when its exact waiting worker becomes active', async () => {
  const consentingTab = await startHarness();
  consentingTab.apply.dispatch('click');
  assert.equal(consentingTab.reloads(), 0,
    'consent must not reload the task while another learner tab still blocks quorum');

  consentingTab.generationB.state = 'activating';
  consentingTab.generationB.dispatch('statechange');
  assert.equal(consentingTab.reloads(), 0,
    'the task remains open until the candidate is fully active');

  consentingTab.generationB.state = 'activated';
  consentingTab.generationB.dispatch('statechange');
  assert.equal(consentingTab.reloads(), 1,
    'the consented tab must advance itself even though activation deliberately does not claim every tab');

  consentingTab.serviceWorker.controller = consentingTab.generationB;
  consentingTab.serviceWorker.dispatch('controllerchange');
  assert.equal(consentingTab.reloads(), 1,
    'statechange and controllerchange races must schedule at most one reload');

  const passiveTab = await startHarness();
  passiveTab.generationB.state = 'activated';
  passiveTab.generationB.dispatch('statechange');
  assert.equal(passiveTab.reloads(), 0,
    'a passive tab that did not press Apply must never be upgraded by another tab consent');
});

test('a consented legacy callback clears private URL state before its update reload', async () => {
  const harness = await startHarness({
    href: 'https://easyboost.test/?login_code=private-code#private-fragment',
  });
  harness.apply.dispatch('click');
  harness.generationB.state = 'activated';
  harness.generationB.dispatch('statechange');
  assert.equal(harness.reloads(), 1);
  assert.deepEqual(harness.replacements, ['/']);
  assert.equal(harness.locationHref(), 'https://easyboost.test/');
});

test('health and the exact legacy login callback stay outside the service-worker response path', async () => {
  const workerIntercepts = await serviceWorkerFetchHarness();
  for (const privateRequest of [
    '/health/live', '/HEALTH/READY', '/?login_code=private-code', '/?login_code=',
  ]) {
    assert.equal(await workerIntercepts(privateRequest), false,
      `${privateRequest} must reach the network directly, without respondWith or cache fallback`);
  }
  assert.equal(await workerIntercepts('/api/v1/me'), false,
    'the existing API private boundary remains direct-to-network');
  for (const ordinaryRequest of ['/', '/healthcheck', '/?not_login_code=public']) {
    assert.equal(await workerIntercepts(ordinaryRequest), true,
      `${ordinaryRequest} remains in the ordinary PWA shell/runtime policy`);
  }
});

test('a superseding waiting generation requires new visible consent while another tab blocks quorum',
  async () => {
    const harness = await startHarness();
    assert.equal(harness.notice.hidden, false);
    harness.apply.dispatch('click');
    assert.deepEqual(harness.generationB.messages.map((message) => message.type), [
      'REGISTER_LEARNER_SHELL_CLIENT', 'SKIP_WAITING',
    ], 'the learner shell registers before recording B consent');
    assert.match(harness.copy.textContent, /остальные вкладки/u,
      'the open nonconsenting peer keeps B waiting');
    assert.equal(harness.intervals.size, 1);

    harness.generationB.state = 'redundant';
    harness.registration.installing = harness.generationC;
    harness.registration.dispatch('updatefound');
    harness.generationC.dispatch('statechange');

    assert.equal(harness.intervals.size, 0, 'C must cancel the B-scoped retry timer');
    assert.deepEqual(harness.generationC.messages.map((message) => message.type), [
      'REGISTER_LEARNER_SHELL_CLIENT',
    ], 'C receives only the learner-shell handshake; B consent must never auto-apply it');
    assert.equal(harness.apply.disabled, false);
    assert.equal(harness.apply.getAttribute('aria-busy'), null);
    assert.equal(harness.apply.textContent, 'Обновить после задания');
    assert.equal(harness.dismiss.hidden, false);
    assert.equal(harness.dismiss.textContent, 'Позже');
    assert.equal(harness.copy.textContent,
      'Текущее задание не прервётся. Завершите шаг и обновите приложение.');

    harness.serviceWorker.dispatch('message', {
      data: { type: 'WAITING_FOR_OTHER_TABS' },
      source: harness.generationB,
    });
    assert.equal(harness.copy.textContent,
      'Текущее задание не прервётся. Завершите шаг и обновите приложение.',
      'a stale B message must not change C UI');

    harness.serviceWorker.controller = harness.generationB;
    harness.serviceWorker.dispatch('controllerchange');
    assert.equal(harness.reloads(), 0, 'late B activation must not consume consent for C');
    assert.deepEqual(harness.generationC.messages.map((message) => message.type), [
      'REGISTER_LEARNER_SHELL_CLIENT',
    ]);

    harness.apply.dispatch('click');
    assert.deepEqual(harness.generationC.messages.map((message) => message.type), [
      'REGISTER_LEARNER_SHELL_CLIENT', 'SKIP_WAITING',
    ],
      'only the second visible Apply records consent for C');
    assert.equal(harness.reloads(), 0, 'the nonconsenting peer must keep C waiting too');
    assert.match(harness.copy.textContent, /остальные вкладки/u);
    assert.equal(harness.dismiss.hidden, true);
    assert.equal(harness.apply.textContent, 'Ждём другие вкладки');
  });
