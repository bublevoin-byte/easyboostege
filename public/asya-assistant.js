const ASYA_WAKE_NAME = 'Ася';
const DEFAULT_TIMEOUT_MS = 60_000;
const ASYA_SESSION_STATES = Object.freeze(['off', 'listening', 'transmitting', 'paused', 'error']);
const CONVERSATION_STATES = new Set(ASYA_SESSION_STATES);
const PRACTICE_SCREENS = new Set([
  'aisy-practice', 'scr2', 'scr3', 'scr4', 'scr7', 'scr8', 'scr9',
  'scr12', 'scr13', 'scr14', 'scr15',
]);
const STRICT_HELP_REFUSAL = 'В диагностике и полном пробнике Ася не подсказывает ответы. Могу помочь с таймером, навигацией или технической ошибкой.';

function boundedTimeout(value) {
  const timeout = Number(value);
  return Number.isSafeInteger(timeout) && timeout >= 10_000 && timeout <= 10 * 60_000
    ? timeout : DEFAULT_TIMEOUT_MS;
}

function exactWakeName(value) {
  return /^\s*ася(?:$|[\s,!.?:;—-])/iu.test(String(value || ''));
}

function projectAsyaContext({ screenId = '', diagnosticActive = false, mockActive = false } = {}) {
  if (screenId === 'scr5' || screenId === 'scr6' || !screenId) {
    return Object.freeze({ id: 'unavailable', available: false, answerHelpAllowed: false, voiceBridgeAllowed: false });
  }
  if (screenId === 'scr16' || mockActive) {
    return Object.freeze({ id: 'mock', available: true, answerHelpAllowed: false, voiceBridgeAllowed: false });
  }
  if (screenId === 'scr10' && diagnosticActive) {
    return Object.freeze({ id: 'diagnostic', available: true, answerHelpAllowed: false, voiceBridgeAllowed: false });
  }
  if (PRACTICE_SCREENS.has(screenId)) {
    return Object.freeze({ id: 'practice', available: true, answerHelpAllowed: true, voiceBridgeAllowed: true });
  }
  const id = screenId === 'scr1' ? 'today'
    : screenId === 'aisy-ege' ? 'ege-hub'
      : screenId === 'scr10' ? 'progress'
        : screenId === 'scr11' ? 'profile' : 'learning';
  return Object.freeze({ id, available: true, answerHelpAllowed: true, voiceBridgeAllowed: false });
}

function authorizeAsyaRequest(context, request = {}) {
  if (!context?.available) {
    return Object.freeze({ allowed: false, reason: 'Ася доступна только после входа в учебную часть Aisy.space.' });
  }
  const kind = String(request.kind || 'answer');
  if (!context.answerHelpAllowed && !['technical', 'timer', 'navigation'].includes(kind)) {
    return Object.freeze({ allowed: false, reason: STRICT_HELP_REFUSAL });
  }
  return Object.freeze({ allowed: true, reason: '' });
}

function classifyAsyaRequest(value) {
  const text = String(value || '').trim().toLocaleLowerCase('ru-RU');
  if (/(?:микрофон|звук|сеть|ошибк|не работает|завис|пропал)/u.test(text)) return Object.freeze({ kind: 'technical', text });
  if (/(?:таймер|сколько остал|времен)/u.test(text)) return Object.freeze({ kind: 'timer', text });
  if (/(?:как вернут|как открыт|где |перейт|навигац)/u.test(text)) return Object.freeze({ kind: 'navigation', text });
  return Object.freeze({ kind: 'answer', text });
}

function freezeConversation(value) {
  return Object.freeze({ ...value });
}

function createAsyaConversation({ now = Date.now(), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return freezeConversation({
    state: 'off',
    active: false,
    disclosureAccepted: false,
    microphoneEnabled: false,
    timeoutMs: boundedTimeout(timeoutMs),
    lastActivityAt: Number(now) || 0,
    timeoutAt: null,
    error: null,
  });
}

function reduceAsyaConversation(current, event = {}, now = Date.now()) {
  const conversation = current && CONVERSATION_STATES.has(current.state)
    ? current : createAsyaConversation({ now });
  const at = Number(now) || 0;
  const next = (changes) => freezeConversation({ ...conversation, ...changes, lastActivityAt: at });
  if (conversation.timeoutAt != null && at >= conversation.timeoutAt
    && !['finish', 'leave', 'microphone-off'].includes(event.type)) {
    return next({ state: 'paused', active: false, microphoneEnabled: false, timeoutAt: null, error: null });
  }
  switch (event.type) {
    case 'open':
      return next({ state: conversation.state === 'paused' ? 'paused' : 'off', error: null });
    case 'accept-disclosure':
      return next({ disclosureAccepted: true, error: null });
    case 'microphone-on':
      if (!conversation.disclosureAccepted) {
        return next({ state: 'error', error: 'DISCLOSURE_REQUIRED', microphoneEnabled: false });
      }
      return next({
        state: 'listening', active: false, microphoneEnabled: true,
        timeoutAt: at + conversation.timeoutMs, error: null,
      });
    case 'speech': {
      if (!conversation.microphoneEnabled || conversation.state === 'off') return conversation;
      if (!conversation.active && !exactWakeName(event.text)) return conversation;
      return next({
        state: 'transmitting', active: true,
        timeoutAt: at + conversation.timeoutMs, error: null,
      });
    }
    case 'keyboard-speech': {
      if (!conversation.active && !exactWakeName(event.text)) return conversation;
      return next({
        state: 'transmitting', active: true,
        timeoutAt: at + conversation.timeoutMs, error: null,
      });
    }
    case 'ready':
      if (!conversation.microphoneEnabled && !conversation.active) return conversation;
      return next({
        state: 'listening', timeoutAt: at + conversation.timeoutMs, error: null,
      });
    case 'pause':
    case 'timeout':
      return next({ state: 'paused', active: false, microphoneEnabled: false, timeoutAt: null, error: null });
    case 'microphone-off':
      return next({ state: 'paused', active: false, microphoneEnabled: false, timeoutAt: null, error: null });
    case 'finish':
    case 'leave':
      return next({ state: 'off', active: false, microphoneEnabled: false, timeoutAt: null, error: null });
    case 'error':
      return next({
        state: 'error', active: false, microphoneEnabled: false, timeoutAt: null,
        error: String(event.code || 'ASYA_UNAVAILABLE'),
      });
    default:
      return conversation;
  }
}

function diagnosticIsActive(document) {
  const section = document.getElementById('adaptive_diagnostic');
  if (!section || section.hidden) return false;
  const form = document.getElementById('adaptive_diagnostic_form');
  const complete = document.getElementById('adaptive_diagnostic_complete');
  return Boolean(section.dataset.diagnosticId || form?.hidden === false || complete?.hidden === false);
}

function contextualReply(document, context, request, authorization) {
  if (!authorization.allowed) return authorization.reason;
  if (request.kind === 'timer') {
    const timer = document.getElementById('ege_mock_timer');
    const value = timer?.textContent?.replace(/\s+/gu, ' ')?.trim();
    return value && value !== '—' ? `На таймере: ${value}.` : 'Таймер сейчас не показан.';
  }
  if (request.kind === 'navigation') {
    return context.id === 'mock'
      ? 'Используйте кнопку «Назад в раздел ЕГЭ»: ответы и сохранённое состояние останутся в попытке.'
      : 'Верхние разделы — Сегодня, Практика, ЕГЭ, Прогресс и Профиль. На глубоком экране есть кнопка возврата в его раздел.';
  }
  if (request.kind === 'technical') {
    return 'Закройте голосовую сессию, проверьте сеть и разрешение микрофона, затем повторите. Текущее задание не сбрасывается.';
  }
  return context.id === 'practice'
    ? 'В практике Ася может разобрать проверенную ошибку. Кнопка голосового разбора появится рядом с такой ошибкой.'
    : 'Ася помогает с планом, навигацией и объяснением после проверки. Ответ за ученика не выбирается.';
}

function defaultVoiceTutorBridge(document) {
  function trigger() {
    return [...document.querySelectorAll('.screen.on .voiceTutorTrigger:not([disabled])')]
      .find((control) => control.offsetParent !== null) || null;
  }
  return Object.freeze({
    available: (context) => Boolean(context?.voiceBridgeAllowed && trigger()),
    start: () => {
      const control = trigger();
      if (!control) return false;
      control.click();
      return true;
    },
  });
}

function installAsyaAssistant({
  document,
  currentScreen,
  registerRouteHook,
  voiceTutorBridge = defaultVoiceTutorBridge(document),
  now = () => Date.now(),
  schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
  cancelSchedule = (timer) => globalThis.clearTimeout(timer),
} = {}) {
  const frame = document?.getElementById('frame');
  if (!frame || typeof currentScreen !== 'function' || typeof registerRouteHook !== 'function') {
    throw new Error('Asya assistant requires the learner shell');
  }
  if (document.getElementById('asya-assistant')) return null;

  const launcher = document.createElement('button');
  launcher.id = 'asya-launcher';
  launcher.className = 'asya-launcher';
  launcher.type = 'button';
  launcher.setAttribute('aria-label', 'Открыть Асю');
  launcher.setAttribute('aria-haspopup', 'dialog');
  launcher.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M4 17c3-8 6-8 9 0s6 8 9 0 6-8 8 0"/><path d="M4 12c3-5 6-5 9 0s6 5 9 0 6-5 8 0"/></svg><span>Ася</span>';

  const root = document.createElement('div');
  root.id = 'asya-assistant';
  root.className = 'asya-assistant';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'asya-title');
  root.innerHTML = `<button class="asya-assistant__backdrop" type="button" aria-label="Закрыть Асю"></button>
    <section class="asya-assistant__panel aisy-surface">
      <header class="asya-assistant__header">
        <span class="asya-assistant__mark" aria-hidden="true"><svg viewBox="0 0 48 48"><path d="M4 26c5-13 10-13 15 0s10 13 15 0 8-13 10 0"/><path d="M4 18c5-8 10-8 15 0s10 8 15 0 8-8 10 0"/></svg></span>
        <div><p class="asya-assistant__eyebrow">Aisy.space</p><h2 id="asya-title">Ася</h2></div>
        <button id="asya-close" class="asya-assistant__close" type="button" aria-label="Завершить разговор с Асей"><span aria-hidden="true">×</span></button>
      </header>
      <p id="asya-context" class="asya-assistant__context"></p>
      <div id="asya-state" class="asya-assistant__state" data-state="off" role="status" aria-live="polite" aria-atomic="true"></div>
      <p class="asya-assistant__disclosure">Ася работает только в открытом приложении и не слушает устройство в фоне. До включения голосового разбора аудио никуда не передаётся. После включения голос передаётся внешнему AI-провайдеру в реальном времени. Исходное аудио и полный transcript не сохраняются.</p>
      <label class="asya-assistant__consent"><input id="asya-disclosure" type="checkbox"><span>Я понимаю, когда голос начнёт передаваться</span></label>
      <button id="asya-microphone" class="aisy-button asya-assistant__microphone" type="button" disabled>Открыть голосовой разбор</button>
      <form id="asya-keyboard" class="asya-assistant__keyboard">
        <label for="asya-input">Написать Асе</label>
        <div><input id="asya-input" maxlength="200" autocomplete="off"><button type="submit" class="aisy-button aisy-button--secondary">Отправить</button></div>
        <p>Начните первую реплику с «Ася». Затем имя повторять не нужно. Клавиатурная команда: Alt+A.</p>
      </form>
      <p id="asya-reply" class="asya-assistant__reply" role="status" aria-live="polite"></p>
      <button id="asya-finish" class="aisy-button aisy-button--secondary asya-assistant__finish" type="button">Завершить разговор</button>
    </section>`;
  frame.append(launcher, root);

  const stateNode = root.querySelector('#asya-state');
  const contextNode = root.querySelector('#asya-context');
  const replyNode = root.querySelector('#asya-reply');
  const disclosure = root.querySelector('#asya-disclosure');
  const microphone = root.querySelector('#asya-microphone');
  const input = root.querySelector('#asya-input');
  let conversation = createAsyaConversation({ now: now() });
  let context = projectAsyaContext({ screenId: currentScreen() });
  let timer = null;
  let returnFocus = null;
  let bridgePending = false;
  let bridgeOperation = 0;

  function contextNow() {
    const screenId = currentScreen();
    return projectAsyaContext({
      screenId,
      diagnosticActive: screenId === 'scr10' && diagnosticIsActive(document),
      mockActive: screenId === 'scr16',
    });
  }

  function stateLabel() {
    if (conversation.state === 'off') return 'Микрофон выключен.';
    if (conversation.state === 'paused') return 'Разговор приостановлен.';
    if (conversation.state === 'transmitting' && bridgePending) {
      return 'Открываю голосовой разбор. Передача начнётся только в его явной микрофонной сессии.';
    }
    if (conversation.state === 'transmitting') return conversation.microphoneEnabled
      ? 'Голос передаётся внешнему AI-провайдеру.'
      : 'Обрабатываю текст на устройстве. Голос никуда не передаётся.';
    if (conversation.state === 'error') return conversation.error === 'VOICE_BRIDGE_UNAVAILABLE'
      ? 'Голосовой разбор доступен после проверенной ошибки в практике.'
      : 'Не удалось открыть голосовую сессию.';
    if (conversation.microphoneEnabled && !conversation.active) return 'Слушаю имя «Ася» в этой открытой сессии.';
    return 'Ася ждёт продолжение. Имя повторять не нужно.';
  }

  function contextLabel() {
    if (!context.answerHelpAllowed) return 'Строгий режим: только таймер, навигация и техническая помощь. Подсказок к ответам нет.';
    if (context.id === 'practice') return 'В практике Ася может объяснить правило и разобрать уже проверенную ошибку.';
    return 'Спросите о плане, навигации или технической помощи.';
  }

  function stopTimer() {
    if (timer != null) cancelSchedule(timer);
    timer = null;
  }

  function armTimer() {
    stopTimer();
    if (conversation.timeoutAt == null) return;
    timer = schedule(() => {
      conversation = reduceAsyaConversation(conversation, { type: 'timeout' }, now());
      render();
    }, Math.max(0, conversation.timeoutAt - now()));
  }

  function render() {
    context = contextNow();
    stateNode.dataset.state = conversation.state;
    stateNode.textContent = stateLabel();
    contextNode.textContent = contextLabel();
    disclosure.checked = conversation.disclosureAccepted;
    microphone.disabled = bridgePending || !conversation.disclosureAccepted;
    microphone.setAttribute('aria-pressed', String(conversation.microphoneEnabled));
    microphone.textContent = conversation.microphoneEnabled ? 'Выключить микрофон' : 'Открыть голосовой разбор';
    armTimer();
  }

  function open() {
    const privacySheet = document.getElementById('privacySheet');
    if (privacySheet?.classList.contains('open')) {
      privacySheet.querySelector('button:not([disabled]), input:not([disabled])')?.focus();
      return;
    }
    returnFocus = document.activeElement;
    context = contextNow();
    if (!context.available) return;
    root.hidden = false;
    conversation = reduceAsyaConversation(conversation, { type: 'open' }, now());
    replyNode.textContent = '';
    render();
    root.querySelector('#asya-close').focus();
  }

  function close(type = 'finish', { restoreFocus = true } = {}) {
    bridgeOperation += 1;
    bridgePending = false;
    conversation = reduceAsyaConversation(conversation, { type }, now());
    stopTimer();
    root.hidden = true;
    replyNode.textContent = '';
    input.value = '';
    const target = restoreFocus ? returnFocus : null;
    returnFocus = null;
    target?.focus?.();
  }

  disclosure.addEventListener('change', () => {
    if (disclosure.checked) conversation = reduceAsyaConversation(conversation, { type: 'accept-disclosure' }, now());
    else conversation = createAsyaConversation({ now: now() });
    render();
  });
  microphone.addEventListener('click', async () => {
    context = contextNow();
    if (conversation.microphoneEnabled) {
      conversation = reduceAsyaConversation(conversation, { type: 'microphone-off' }, now());
      render();
      return;
    }
    conversation = reduceAsyaConversation(conversation, { type: 'microphone-on' }, now());
    render();
    if (!voiceTutorBridge?.available?.(context)) {
      conversation = reduceAsyaConversation(conversation, { type: 'error', code: 'VOICE_BRIDGE_UNAVAILABLE' }, now());
      render();
      return;
    }
    conversation = reduceAsyaConversation(conversation, { type: 'speech', text: ASYA_WAKE_NAME }, now());
    const operation = ++bridgeOperation;
    bridgePending = true;
    render();
    let started = false;
    try { started = await voiceTutorBridge.start(); } catch {}
    if (operation !== bridgeOperation || root.hidden) return;
    bridgePending = false;
    if (started) close('finish', { restoreFocus: false });
    else {
      conversation = reduceAsyaConversation(conversation, { type: 'error', code: 'VOICE_BRIDGE_UNAVAILABLE' }, now());
      render();
    }
  });
  root.querySelector('#asya-keyboard').addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    const before = conversation;
    conversation = reduceAsyaConversation(conversation, { type: 'keyboard-speech', text: value }, now());
    input.value = '';
    if (!before.active && !conversation.active) {
      replyNode.textContent = 'Чтобы начать или возобновить разговор, первое сообщение должно начинаться с «Ася».';
      render();
      return;
    }
    context = contextNow();
    const request = classifyAsyaRequest(value);
    const authorization = authorizeAsyaRequest(context, request);
    replyNode.textContent = contextualReply(document, context, request, authorization);
    conversation = reduceAsyaConversation(conversation, { type: 'ready' }, now());
    render();
  });

  function trapFocus(event) {
    if (event.key === 'Escape') { event.preventDefault(); close('finish'); return; }
    if (event.key !== 'Tab') return;
    const controls = [...root.querySelectorAll('button,input')]
      .filter((control) => !control.disabled && control.offsetParent !== null);
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  launcher.addEventListener('click', open);
  root.querySelector('.asya-assistant__backdrop').addEventListener('click', () => close('finish'));
  root.querySelector('#asya-close').addEventListener('click', () => close('finish'));
  root.querySelector('#asya-finish').addEventListener('click', () => close('finish'));
  root.addEventListener('keydown', trapFocus);
  document.addEventListener('keydown', (event) => {
    if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLocaleLowerCase('en-US') === 'a') {
      event.preventDefault();
      if (root.hidden) open(); else input.focus();
    }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden && !root.hidden) close('leave'); });
  registerRouteHook((screenId, previousScreenId) => {
    context = contextNow();
    launcher.hidden = !context.available;
    if (screenId !== previousScreenId && !root.hidden) close('leave');
  });
  launcher.hidden = !context.available;
  render();
  return Object.freeze({ launcher, root, open, close, conversation: () => conversation, context: () => contextNow() });
}

export {
  ASYA_WAKE_NAME,
  ASYA_SESSION_STATES,
  authorizeAsyaRequest,
  classifyAsyaRequest,
  createAsyaConversation,
  exactWakeName,
  installAsyaAssistant,
  projectAsyaContext,
  reduceAsyaConversation,
};
