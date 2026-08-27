import { browserRealtimeTransport } from './realtime-transport.js';
import {
  canStartVoiceTutor,
  eventForVoiceTutorState,
  prepareVoiceTutorContextResult,
  voiceTutorButton,
  voiceTutorResultSlot,
  voiceTutorSlotId,
} from './voice-tutor-contract.js';

export {
  canStartVoiceTutor,
  eventForVoiceTutorState,
  prepareVoiceTutorContextResult,
  voiceTutorButton,
  voiceTutorResultSlot,
} from './voice-tutor-contract.js';

const browser = globalThis.window || globalThis;

let currentSession = null;
let returnFocus = null;
let timerId = null;
let mediaStream = null;
let realtimeConnection = null;
let realtimeOperation = 0;
let fallbackPending = false;
let sessionOperation = 0;
let interactionSequence = 0;
let interactionOperation = null;
let reportSequence = 0;
let reportOperation = null;
let lastMinuteAnnounced = false;
let currentSessionRecovery = null;
const transientCaptions = [];
const pendingSessionKeys = new Map();
let runtime = {
  api: null,
  mediaDevices: null,
  realtime: null,
  now: () => Date.now(),
};

function api() {
  return runtime.api || browser.EasyBoostApi;
}

function mediaDevices() {
  return runtime.mediaDevices || browser.navigator?.mediaDevices;
}

function operationActive(operation) {
  return operation === sessionOperation
    && Boolean(browser.document?.getElementById('voiceTutorSheet')?.classList.contains('open'));
}

function captureInteractionContext() {
  const sessionId = currentSession?.session?.id;
  const nonce = currentSession?.nonce;
  if (!sessionId || !nonce) return null;
  return Object.freeze({ operation: sessionOperation, sessionId, nonce });
}

function interactionContextActive(context, acceptedNonce = null) {
  return Boolean(context)
    && operationActive(context.operation)
    && currentSession?.session?.id === context.sessionId
    && (currentSession?.nonce === context.nonce
      || (acceptedNonce != null && currentSession?.nonce === acceptedNonce));
}

function sameInteractionContext(left, right) {
  return Boolean(left && right)
    && left.operation === right.operation
    && left.sessionId === right.sessionId
    && left.nonce === right.nonce;
}

function setInteractionBusy(busy) {
  const answer = browser.document?.getElementById('voiceTutorAnswer');
  const quick = browser.document?.querySelector?.('.vtQuick');
  for (const region of [answer, quick]) region?.setAttribute?.('aria-busy', String(busy));
  const controls = [
    browser.document?.getElementById('voiceTutorInput'),
    answer?.querySelector?.('button[type="submit"]'),
    browser.document?.getElementById('voiceTutorClarify'),
    browser.document?.getElementById('voiceTutorExplainDifferently'),
  ];
  for (const control of controls) {
    if (!control) continue;
    control.disabled = busy;
    control.setAttribute?.('aria-busy', String(busy));
  }
}

function claimInteraction(context) {
  if (!context) return null;
  if (interactionOperation && sameInteractionContext(interactionOperation.context, context)) return null;
  if (interactionOperation) {
    interactionOperation = null;
    setInteractionBusy(false);
  }
  const operation = Object.freeze({ id: ++interactionSequence, context });
  interactionOperation = operation;
  setInteractionBusy(true);
  return operation;
}

function releaseInteraction(operation) {
  if (interactionOperation !== operation) return;
  interactionOperation = null;
  setInteractionBusy(false);
}

function cancelInteraction() {
  if (!interactionOperation) return;
  interactionOperation = null;
  setInteractionBusy(false);
}

function setTutorReportBusy(busy) {
  const region = browser.document?.querySelector?.('.vtReport');
  const reason = browser.document?.getElementById('voiceTutorReportReason');
  const button = browser.document?.getElementById('voiceTutorReport');
  region?.setAttribute?.('aria-busy', String(busy));
  for (const control of [reason, button]) {
    if (!control) continue;
    control.disabled = busy;
    control.setAttribute?.('aria-busy', String(busy));
  }
}

function setTutorReportStatus(state, message) {
  const status = browser.document?.getElementById('voiceTutorReportStatus');
  if (!status) return;
  status.dataset.state = state;
  status.setAttribute?.('role', state === 'error' ? 'alert' : 'status');
  status.textContent = String(message || '');
}

function cancelTutorReport() {
  if (!reportOperation) return;
  reportOperation = null;
  setTutorReportBusy(false);
}

function creationFingerprint(body) {
  return JSON.stringify(body);
}

function rememberPendingSessionKey(fingerprint, key, operation) {
  if (pendingSessionKeys.size >= 8 && !pendingSessionKeys.has(fingerprint)) {
    pendingSessionKeys.delete(pendingSessionKeys.keys().next().value);
  }
  const entry = Object.freeze({ key, operation });
  pendingSessionKeys.set(fingerprint, entry);
  return { fingerprint, key };
}

function idempotencyKeyFor(body, operation) {
  const fingerprint = creationFingerprint(body);
  const existing = pendingSessionKeys.get(fingerprint);
  if (existing?.operation === operation) return { fingerprint, key: existing.key };
  return rememberPendingSessionKey(fingerprint, browser.crypto.randomUUID(), operation);
}

function pendingKeyClaimedByAnotherOperation(fingerprint, key, operation) {
  const pending = pendingSessionKeys.get(fingerprint);
  if (pending?.key === key && pending.operation !== operation) return true;
  return currentSessionRecovery?.fingerprint === fingerprint
    && currentSessionRecovery?.key === key
    && sessionOperation !== operation;
}

function releasePendingSessionKey(fingerprint, key, operation) {
  const pending = pendingSessionKeys.get(fingerprint);
  if (pending?.key === key && pending.operation === operation) pendingSessionKeys.delete(fingerprint);
}

async function postIdempotentWithNetworkRetry(path, body, key, operation) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await api().postIdempotent(path, body, key); }
    catch (error) {
      if (error?.code !== 'NETWORK_ERROR' || attempt > 0 || !operationActive(operation)) throw error;
      setVoiceTutorUiState('recovering', 'Восстанавливаем созданный разбор без повторного списания…', { busy: true });
    }
  }
  throw new Error('NETWORK_ERROR');
}

async function finishCancelledSession(result) {
  const sessionId = result?.session?.id;
  if (!sessionId) return;
  try { updateProfileAccess(await api().post(`/api/v1/voice-tutor/sessions/${sessionId}/finish`, {})); } catch {}
}

export function configureVoiceTutor(options = {}) {
  runtime = { ...runtime, ...options };
}

export async function registerVoiceTutorError({ module, itemId, revision, learnerAnswer } = {}, authority = {}) {
  if (!canStartVoiceTutor() || !browser.crypto?.randomUUID) return null;
  const owner = String(authority.owner || '').trim();
  if (!owner) throw Object.assign(new Error('Expected account is required.'), { status: 400, code: 'EXPECTED_OWNER_REQUIRED' });
  const attemptId = browser.crypto.randomUUID();
  const result = await api().post('/api/v1/voice-tutor/errors', {
    attemptId,
    module,
    itemId,
    revision,
    learnerAnswer: String(learnerAnswer || '').slice(0, 200),
  }, { 'X-EasyBoost-Expected-Owner': owner });
  if (typeof api().responseOwner !== 'function' || api().responseOwner(result) !== owner) {
    throw Object.assign(new Error('Authenticated account changed.'), { status: 409, code: 'OWNER_CHANGED' });
  }
  return { attemptId, revision };
}

export async function registerVoiceTutorContextResult({ module, setId, revision, answers } = {}, authority = {}, isCurrent) {
  if (!canStartVoiceTutor() || !browser.crypto?.randomUUID) return null;
  const owner = String(authority.username || authority.owner || '').trim();
  if (!owner) throw Object.assign(new Error('Expected account is required.'), { status: 400, code: 'EXPECTED_OWNER_REQUIRED' });
  if (typeof isCurrent === 'function' && !isCurrent()) return null;
  const result = await api().post('/api/v1/voice-tutor/context-attempts', {
    attemptId: browser.crypto.randomUUID(),
    module,
    setId,
    revision,
    answers,
  }, { 'X-EasyBoost-Expected-Owner': owner });
  if (typeof api().responseOwner !== 'function' || api().responseOwner(result) !== owner) {
    throw Object.assign(new Error('Authenticated account changed.'), { status: 409, code: 'OWNER_CHANGED' });
  }
  if (typeof isCurrent === 'function' && !isCurrent()) return null;
  for (const error of result?.errors || []) {
    if (typeof isCurrent === 'function' && !isCurrent()) return null;
    const slot = browser.document?.getElementById(voiceTutorSlotId(error.item_id));
    if (slot) slot.innerHTML = voiceTutorButton({ attemptId: error.attempt_id, revision: error.revision });
  }
  return result;
}

function ensureSheet() {
  const document = browser.document;
  if (!document || document.getElementById('voiceTutorSheet')) return;
  const sheet = document.createElement('div');
  sheet.id = 'voiceTutorSheet';
  sheet.dataset.state = 'idle';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'voiceTutorTitle');
  sheet.setAttribute('aria-describedby', 'voiceTutorPrivacy');
  sheet.setAttribute('aria-busy', 'false');
  sheet.innerHTML = `<button class="vtBackdrop" type="button" tabindex="-1" aria-label="Закрыть разбор"></button><section class="vtPanel aisy-surface" aria-busy="false"><div class="vtGrip"></div>
    <div class="vtHead"><span class="vtMark" aria-hidden="true">А</span><div class="vtHeadCopy"><p class="vtEyebrow">Ася · Voice Tutor</p><h2 id="voiceTutorTitle">Разбор проверенной ошибки</h2><p id="voiceTutorPrivacy">Голос передаётся внешнему провайдеру только в этой сессии. Аудио и полный transcript не сохраняются.</p></div><button id="voiceTutorClose" class="vtClose" type="button" aria-label="Завершить разбор и вернуться в упражнение">×</button></div>
    <div class="vtMeta"><span id="voiceTutorTimer" class="vtPill" role="timer">Осталось 0:00</span><span id="voiceTutorQuota" class="vtPill">Остаток уточняется…</span><span class="vtPill">ИИ · не официальный балл ЕГЭ</span><span id="voiceTutorTimeWarning" class="vtTimeWarning" role="status" aria-live="polite" hidden></span></div>
    <div class="vtCapsule"><b id="voiceTutorSkill">Готовим контекст…</b><span id="voiceTutorPrompt"></span><span id="voiceTutorContext" class="vtContext" hidden></span></div>
    <div id="voiceTutorSources" class="vtSources" hidden></div>
    <div id="voiceTutorCaptions" class="vtCaptions" aria-live="polite" aria-atomic="false"></div>
    <div id="voiceTutorStatus" class="vtStatus" data-state="connecting" role="status" aria-live="polite" aria-atomic="true" aria-busy="true"><span class="vtStatusSignal" aria-hidden="true"></span><div class="vtStatusCopy"><strong id="voiceTutorStateTitle">Подключение</strong><span id="voiceTutorState" class="vtState">Подключаем репетитора…</span></div></div>
    <div class="vtControls"><button id="voiceTutorMic" class="vtMic" type="button" aria-label="Включить или выключить микрофон" aria-pressed="false" disabled><svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm-7-3a7 7 0 0 0 14 0M12 19v3M9 22h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button><button id="voiceTutorRetry" class="aisy-button aisy-button--secondary vtRetry" type="button" hidden>Повторить подключение</button><button id="voiceTutorUseText" class="aisy-button aisy-button--secondary vtUseText" type="button" hidden>Продолжить текстом</button></div>
    <form id="voiceTutorAnswer" class="vtAnswer" hidden><label for="voiceTutorInput">Ваш ответ репетитору</label><input id="voiceTutorInput" maxlength="200" autocomplete="off"><button type="submit" class="aisy-button">Продолжить</button></form>
    <div class="vtQuick" hidden><button id="voiceTutorClarify" class="aisy-button aisy-button--secondary" type="button">Уточнить вопросом</button><button id="voiceTutorExplainDifferently" class="aisy-button aisy-button--secondary" type="button">Объясни иначе</button></div>
    <div class="vtReport" aria-busy="false"><label for="voiceTutorReportReason">Сообщить о проблеме</label><div><select id="voiceTutorReportReason"><option value="incorrect_rule">Неверное правило</option><option value="unclear_explanation">Непонятное объяснение</option><option value="bad_example">Неудачный пример</option><option value="technical_issue">Техническая проблема</option></select><button id="voiceTutorReport" class="aisy-button aisy-button--secondary" type="button">Отправить</button></div><p id="voiceTutorReportStatus" class="vtReportStatus" data-state="idle" role="status" aria-live="polite"></p></div>
    <button id="voiceTutorFinish" class="aisy-button aisy-button--secondary vtFinish" type="button">Завершить и вернуться в упражнение</button></section>`;
  document.body.appendChild(sheet);
  sheet.querySelector('.vtBackdrop').addEventListener('click', finishVoiceTutor);
  document.getElementById('voiceTutorClose').addEventListener('click', finishVoiceTutor);
  document.getElementById('voiceTutorFinish').addEventListener('click', finishVoiceTutor);
  document.getElementById('voiceTutorMic').addEventListener('click', toggleMicrophone);
  document.getElementById('voiceTutorRetry').addEventListener('click', retryVoiceTutor);
  document.getElementById('voiceTutorUseText').addEventListener('click', () => switchToFallback('microphone_unavailable'));
  document.getElementById('voiceTutorAnswer').addEventListener('submit', submitTutorStep);
  document.getElementById('voiceTutorClarify').addEventListener('click', submitClarification);
  document.getElementById('voiceTutorExplainDifferently').addEventListener('click', explainDifferently);
  document.getElementById('voiceTutorReport').addEventListener('click', submitTutorReport);
  sheet.addEventListener('keydown', trapSheetFocus);
}

function text(id, value) {
  const element = browser.document?.getElementById(id);
  if (element) element.textContent = String(value ?? '');
}

const VOICE_TUTOR_UI_TITLES = Object.freeze({
  idle: 'Разбор',
  connecting: 'Подключение',
  recovering: 'Восстановление',
  voice: 'Голосовой режим',
  'text-fallback': 'Текстовый режим',
  quota: 'Лимит исчерпан',
  complete: 'Разбор завершён',
  error: 'Не удалось продолжить',
});

function setVoiceTutorUiState(state, message, {
  busy = false, allowRetry = false, allowTextFallback = false,
} = {}) {
  const sheet = browser.document?.getElementById('voiceTutorSheet');
  if (!sheet) return;
  const normalized = Object.hasOwn(VOICE_TUTOR_UI_TITLES, state) ? state : 'idle';
  sheet.dataset.state = normalized;
  sheet.setAttribute('aria-busy', String(busy));
  const panel = sheet.querySelector?.('.vtPanel');
  panel?.setAttribute('aria-busy', String(busy));
  const status = browser.document.getElementById('voiceTutorStatus');
  if (status) {
    status.dataset.state = normalized;
    status.setAttribute('aria-busy', String(busy));
  }
  text('voiceTutorStateTitle', VOICE_TUTOR_UI_TITLES[normalized]);
  if (message != null) text('voiceTutorState', message);
  const voiceSession = currentSession?.mode === 'voice' && Boolean(currentSession?.nonce);
  const microphone = browser.document.getElementById('voiceTutorMic');
  if (microphone) {
    microphone.hidden = !voiceSession;
    microphone.disabled = normalized !== 'voice' || fallbackPending;
  }
  const useText = browser.document.getElementById('voiceTutorUseText');
  if (useText) {
    useText.hidden = !(allowTextFallback && voiceSession && !fallbackPending);
    useText.disabled = fallbackPending;
  }
  const retry = browser.document.getElementById('voiceTutorRetry');
  if (retry) {
    retry.hidden = !(allowRetry && currentSessionRecovery);
    retry.disabled = busy;
  }
}

function isVoiceTutorQuota(value) {
  const code = String(value?.code || value?.error?.code || value?.voice_unavailable?.code || '');
  return Number(value?.status) === 429 || /QUOTA(?:_|$)/u.test(code);
}

function showVoiceTutorError(error, { allowRetry = error?.code === 'NETWORK_ERROR' || Boolean(currentSession?.session?.id) } = {}) {
  if (isVoiceTutorQuota(error)) {
    setVoiceTutorUiState('quota', api().messageFor(error));
    return;
  }
  setVoiceTutorUiState('error', api().messageFor(error), {
    allowRetry,
    allowTextFallback: currentSession?.mode === 'voice' && Boolean(currentSession?.nonce),
  });
}

function addCaption(value) {
  const caption = String(value || '').trim();
  if (!caption) return;
  transientCaptions.push(caption);
  if (transientCaptions.length > 8) transientCaptions.shift();
  text('voiceTutorCaptions', transientCaptions.join('\n'));
}

function quotaText(access) {
  const daily = Math.ceil(Number(access?.daily_remaining_seconds || 0) / 60);
  const monthly = Math.ceil(Number(access?.monthly_remaining_seconds || 0) / 60);
  return `Осталось ${daily} мин сегодня · ${monthly} мин в месяце`;
}

function updateProfileAccess(result) {
  if (!result?.voice_tutor || !browser.__sub) return;
  browser.__sub = { ...browser.__sub, voice_tutor: { ...result.voice_tutor } };
}

function statePrompt(session) {
  if (!session) return '';
  if (session.state === 'diagnose') return 'Сначала уточним, почему выбран этот ответ.';
  if (session.state === 'explain') return currentSession.capsule.rule.explanation;
  if (session.state === 'micro_check') return currentSession.capsule.checks.micro_check.prompt;
  if (session.state === 'transfer_task') return currentSession.capsule.checks.transfer_task.prompt;
  if (session.state === 'resolved') return 'Готово: правило проверено на новом примере.';
  if (session.state === 'fallback') return 'Сохрани правило и вернись к упражнению.';
  return 'Разбор завершён.';
}

function renderSession(result) {
  currentSession = { ...currentSession, ...result, session: result.session || currentSession?.session, capsule: result.capsule || currentSession?.capsule };
  text('voiceTutorSkill', currentSession.capsule.skill.label);
  text('voiceTutorPrompt', currentSession.capsule.item.prompt);
  const context = currentSession.capsule.item.context;
  const contextElement = browser.document.getElementById('voiceTutorContext');
  if (contextElement) {
    contextElement.hidden = !context;
    contextElement.textContent = context ? `${context.label}: “${context.text}”` : '';
  }
  text('voiceTutorQuota', quotaText(currentSession.voice_tutor));
  updateProfileAccess(currentSession);
  const message = result.text_turn?.message || statePrompt(currentSession.session);
  addCaption(message);
  const terminal = ['resolved', 'fallback', 'ended'].includes(currentSession.session.state);
  const quotaExhausted = isVoiceTutorQuota(currentSession);
  const form = browser.document.getElementById('voiceTutorAnswer');
  if (form) form.hidden = currentSession.mode === 'voice' || terminal;
  const quick = browser.document.querySelector?.('.vtQuick');
  if (quick) quick.hidden = !(currentSession.mode === 'text' && ['diagnose', 'explain'].includes(currentSession.session.state));
  if (quotaExhausted) {
    setVoiceTutorUiState('quota', currentSession.voice_unavailable?.message || message);
  } else if (terminal && currentSession.session.state !== 'fallback') {
    setVoiceTutorUiState('complete', message);
  } else if (currentSession.mode === 'voice') {
    setVoiceTutorUiState('voice', message, { allowTextFallback: !terminal });
  } else {
    setVoiceTutorUiState('text-fallback', message);
  }
}

function renderTrustedRuleDiscovery(result) {
  if (result?.provisional !== true || !result.rule?.explanation || !Array.isArray(result.sources)) {
    throw new Error('TRUSTED_RULE_EVIDENCE_INVALID');
  }
  const message = `${result.notice || 'Предварительное правило ожидает проверки преподавателем.'} ${result.rule.explanation}`;
  setVoiceTutorUiState('text-fallback', message);
  addCaption(message);
  const sources = browser.document?.getElementById('voiceTutorSources');
  if (!sources) return;
  sources.replaceChildren();
  const heading = browser.document.createElement('b');
  heading.textContent = 'Доверенные источники';
  sources.appendChild(heading);
  for (const [index, value] of result.sources.entries()) {
    let sourceUrl;
    try {
      sourceUrl = new URL(String(value));
      if (sourceUrl.protocol !== 'https:') continue;
    } catch { continue; }
    const sourceLink = browser.document.createElement('a');
    sourceLink.href = sourceUrl.toString();
    sourceLink.target = '_blank';
    sourceLink.rel = 'noopener noreferrer';
    sourceLink.textContent = `Источник ${index + 1}: ${sourceUrl.hostname}`;
    sources.appendChild(sourceLink);
  }
  sources.hidden = sources.childElementCount < 2;
}

async function discoverMissingRule(result, operation) {
  const context = captureInteractionContext();
  if (!context || context.operation !== operation
    || context.sessionId !== result?.session?.id || context.nonce !== result?.nonce) return null;
  const interaction = claimInteraction(context);
  if (!interaction) return null;
  setVoiceTutorUiState('recovering', 'Ищем правило в доверенных источниках…', { busy: true });
  try {
    const provisional = await api().post('/api/v1/voice-tutor/rule-discoveries', {
      session_id: context.sessionId, nonce: context.nonce,
    });
    if (!interactionContextActive(context)) return null;
    if (provisional.capsule) renderSession({ ...provisional, mode: currentSession.mode });
    renderTrustedRuleDiscovery(provisional);
    return provisional;
  } catch (error) {
    if (!interactionContextActive(context)) return null;
    throw error;
  } finally {
    releaseInteraction(interaction);
  }
}

function updateTimer() {
  if (!currentSession?.session) return;
  const end = new Date(currentSession.session.expires_at).getTime();
  const now = runtime.now();
  const remaining = Math.max(0, Math.ceil((end - now) / 1000));
  const remainingText = `Осталось ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
  text('voiceTutorTimer', remainingText);
  const timer = browser.document.getElementById('voiceTutorTimer');
  const lastMinute = remaining > 0 && remaining <= 60;
  if (timer) {
    timer.classList.toggle('vtWarn', lastMinute);
    timer.setAttribute('aria-label', remainingText);
  }
  const warning = browser.document.getElementById('voiceTutorTimeWarning');
  if (warning && lastMinute && !lastMinuteAnnounced) {
    warning.hidden = false;
    warning.textContent = 'Осталась последняя минута голосового разбора.';
    lastMinuteAnnounced = true;
  }
  if (remaining === 0 && currentSession.mode === 'voice') void switchToFallback('session_timeout');
}

function startTimer() {
  browser.clearInterval(timerId);
  lastMinuteAnnounced = false;
  const warning = browser.document?.getElementById('voiceTutorTimeWarning');
  if (warning) { warning.hidden = true; warning.textContent = ''; }
  updateTimer();
  timerId = browser.setInterval(updateTimer, 1_000);
}

function stopMedia({ clean = false } = {}) {
  realtimeOperation += 1;
  mediaStream?.getTracks?.().forEach((track) => track.stop());
  mediaStream = null;
  const closing = realtimeConnection?.close?.({ clean });
  realtimeConnection = null;
  const mic = browser.document?.getElementById('voiceTutorMic');
  if (mic) mic.setAttribute('aria-pressed', 'false');
  return Promise.resolve(closing);
}

async function startMicrophone(operation = sessionOperation) {
  const connectionOperation = ++realtimeOperation;
  let connection = null;
  let stream = null;
  try {
    setVoiceTutorUiState('connecting', 'Подключаем защищённую голосовую сессию…', {
      busy: true, allowTextFallback: true,
    });
    const connector = runtime.realtime || browserRealtimeTransport;
    if (!connector?.connect) throw new Error('realtime transport unavailable');
    connection = await connector.connect({
      ticket: currentSession.realtime.ticket,
      url: currentSession.realtime.proxy_url,
      onSubtitle: addCaption,
      onStatus: (status) => {
        if (operationActive(operation) && connectionOperation === realtimeOperation) {
          const connected = /подключ[её]н/iu.test(String(status || ''));
          setVoiceTutorUiState(connected ? 'voice' : 'connecting', status, {
            busy: !connected, allowTextFallback: true,
          });
        }
      },
      onPedagogicalEvent: advanceTutorSession,
      onFailure: () => {
        if (operationActive(operation)) void switchToFallback('provider_unavailable');
      },
    });
    if (!operationActive(operation) || connectionOperation !== realtimeOperation) {
      await connection.close?.({ clean: true });
      return;
    }
    realtimeConnection = connection;
    stream = await mediaDevices().getUserMedia({ audio: true });
    if (!operationActive(operation) || connectionOperation !== realtimeOperation || realtimeConnection !== connection) {
      stream?.getTracks?.().forEach((track) => track.stop());
      await connection.close?.({ clean: true });
      return;
    }
    mediaStream = stream;
    connection.activate(stream);
    browser.document.getElementById('voiceTutorMic')?.setAttribute('aria-pressed', 'true');
    setVoiceTutorUiState('voice', 'Голосовой репетитор подключён. Микрофон работает только в этой сессии.', {
      allowTextFallback: true,
    });
  } catch {
    if (!operationActive(operation) || connectionOperation !== realtimeOperation) {
      stream?.getTracks?.().forEach((track) => track.stop());
      if (realtimeConnection === connection) realtimeConnection = null;
      await connection?.close?.({ clean: true });
      return;
    }
    await switchToFallback(realtimeConnection ? 'microphone_unavailable' : 'provider_unavailable');
  }
}

async function toggleMicrophone() {
  if (mediaStream) {
    await switchToFallback('microphone_unavailable');
  } else if (currentSession?.mode === 'voice') {
    await startMicrophone();
  }
}

async function retryVoiceTutor() {
  const recovery = currentSessionRecovery;
  const sheet = browser.document?.getElementById('voiceTutorSheet');
  if (!recovery || !sheet?.classList.contains('open')) return;
  if (!canStartVoiceTutor()) {
    currentSessionRecovery = null;
    setVoiceTutorUiState('error', 'Голосовой разбор больше недоступен для текущего профиля. Вернитесь в упражнение.');
    return;
  }
  const recoveryOperation = ++sessionOperation;
  browser.clearInterval(timerId);
  timerId = null;
  fallbackPending = false;
  setVoiceTutorUiState('recovering', 'Проверяем текущий разбор без новой попытки и повторного списания…', { busy: true });
  await stopMedia({ clean: true });
  if (!operationActive(recoveryOperation) || currentSessionRecovery !== recovery) return;
  await openVoiceTutorError(recovery.details, recovery);
}

async function switchToFallback(reason = 'microphone_unavailable') {
  if (fallbackPending || !currentSession?.nonce || currentSession.mode !== 'voice') return;
  fallbackPending = true;
  const operation = sessionOperation;
  const sessionId = currentSession.session.id;
  const nonce = currentSession.nonce;
  setVoiceTutorUiState('recovering', 'Переключаем разбор в безопасный текстовый режим…', { busy: true });
  await stopMedia({ clean: reason === 'microphone_unavailable' });
  try {
    const result = await api().post(`/api/v1/voice-tutor/sessions/${sessionId}/fallback`, { nonce, reason });
    if (operationActive(operation) && currentSession?.session?.id === sessionId && currentSession?.nonce === nonce) {
      renderSession(result);
    }
  } catch (error) {
    if (operationActive(operation) && currentSession?.session?.id === sessionId
      && currentSession?.nonce === nonce) showVoiceTutorError(error);
  } finally {
    if (operationActive(operation) && currentSession?.session?.id === sessionId) {
      fallbackPending = false;
      if (currentSession?.mode === 'voice') {
        const status = browser.document?.getElementById('voiceTutorStatus');
        if (status?.dataset.state === 'recovering') {
          setVoiceTutorUiState('voice', statePrompt(currentSession.session), { allowTextFallback: true });
        }
      }
    }
  }
}

async function submitTutorStep(event) {
  event.preventDefault();
  const context = captureInteractionContext();
  if (!context) return;
  const input = browser.document.getElementById('voiceTutorInput');
  const tutorEvent = eventForVoiceTutorState(currentSession.session.state, input?.value || '');
  if (!tutorEvent) return;
  if (currentSession.session.state === 'diagnose' && !String(tutorEvent.answer || '').trim()) {
    text('voiceTutorState', 'Коротко напишите, почему вы выбрали этот ответ.');
    return;
  }
  try {
    const result = await advanceTutorSession(tutorEvent);
    if (result && interactionContextActive(context, result?.nonce)
      && browser.document.getElementById('voiceTutorInput') === input) input.value = '';
  } catch (error) {
    if (interactionContextActive(context)) showVoiceTutorError(error);
  }
}

async function requestClarification(kind, message = '') {
  const context = captureInteractionContext();
  if (!context) return null;
  const interaction = claimInteraction(context);
  if (!interaction) return null;
  try {
    const result = await api().post(`/api/v1/voice-tutor/sessions/${context.sessionId}/clarifications`, {
      nonce: context.nonce, kind, ...(message ? { message } : {}),
    });
    if (interactionContextActive(context)) renderSession(result);
    return result;
  } finally {
    releaseInteraction(interaction);
  }
}

async function submitClarification() {
  const context = captureInteractionContext();
  if (!context) return;
  const input = browser.document.getElementById('voiceTutorInput');
  const message = String(input?.value || '').trim();
  if (!message) { text('voiceTutorState', 'Введите короткий вопрос по текущему правилу.'); return; }
  try {
    const result = await requestClarification('clarify', message);
    if (result && interactionContextActive(context, result?.nonce)
      && browser.document.getElementById('voiceTutorInput') === input) input.value = '';
  } catch (error) {
    if (interactionContextActive(context)) showVoiceTutorError(error);
  }
}

async function explainDifferently() {
  const context = captureInteractionContext();
  if (!context) return;
  try { await requestClarification('explain_differently'); }
  catch (error) { if (interactionContextActive(context)) showVoiceTutorError(error); }
}

async function submitTutorReport() {
  const reason = browser.document.getElementById('voiceTutorReportReason')?.value;
  const sessionId = currentSession?.session?.id;
  if (!sessionId || !reason || reportOperation) return;
  const operation = Object.freeze({ id: ++reportSequence, sessionOperation, sessionId });
  reportOperation = operation;
  setTutorReportBusy(true);
  setTutorReportStatus('processing', 'Отправляем сообщение на проверку…');
  try {
    await api().post('/api/v1/voice-tutor/reports', { session_id: sessionId, reason });
    if (reportOperation === operation && operationActive(operation.sessionOperation)
      && currentSession?.session?.id === sessionId) {
      setTutorReportStatus('success', 'Спасибо. Сообщение отправлено на проверку преподавателю.');
    }
  } catch (error) {
    if (reportOperation === operation && operationActive(operation.sessionOperation)
      && currentSession?.session?.id === sessionId) {
      setTutorReportStatus('error', 'Не удалось отправить сообщение. Проверь соединение и повтори.');
    }
  } finally {
    if (reportOperation === operation) {
      reportOperation = null;
      if (operationActive(operation.sessionOperation) && currentSession?.session?.id === sessionId) {
        setTutorReportBusy(false);
      }
    }
  }
}

async function advanceTutorSession(tutorEvent, { callId = null } = {}) {
  const context = captureInteractionContext();
  if (!context || !tutorEvent) throw new Error('VOICE_TUTOR_EVENT_INVALID');
  const interaction = claimInteraction(context);
  if (!interaction) return null;
  try {
    const result = await api().post(`/api/v1/voice-tutor/sessions/${context.sessionId}/events`, {
      nonce: context.nonce,
      event: tutorEvent,
      ...(callId ? { provider_call_id: callId } : {}),
    });
    if (interactionContextActive(context)) renderSession(result);
    return result;
  } finally {
    releaseInteraction(interaction);
  }
}

function trapSheetFocus(event) {
  if (event.key === 'Escape') { event.preventDefault(); finishVoiceTutor(); return; }
  if (event.key !== 'Tab') return;
  const panel = event.currentTarget.querySelector('.vtPanel');
  const controls = [...(panel?.querySelectorAll('button,input,select,a[href],textarea') || [])]
    .filter((element) => !element.disabled && element.offsetParent !== null);
  if (!controls.length) return;
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && browser.document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && browser.document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function closeSheet({ clean = false } = {}) {
  sessionOperation += 1;
  cancelInteraction();
  cancelTutorReport();
  browser.clearInterval(timerId);
  timerId = null;
  const closing = stopMedia({ clean });
  transientCaptions.length = 0;
  text('voiceTutorCaptions', '');
  const sources = browser.document?.getElementById('voiceTutorSources');
  if (sources) { sources.replaceChildren(); sources.hidden = true; }
  const sheet = browser.document?.getElementById('voiceTutorSheet');
  sheet?.classList.remove('open');
  if (sheet) {
    sheet.dataset.state = 'idle';
    sheet.setAttribute('aria-busy', 'false');
    sheet.querySelector?.('.vtPanel')?.setAttribute('aria-busy', 'false');
  }
  const focus = returnFocus;
  currentSession = null;
  currentSessionRecovery = null;
  fallbackPending = false;
  lastMinuteAnnounced = false;
  returnFocus = null;
  focus?.focus?.();
  return closing;
}

export async function finishVoiceTutor() {
  const sessionId = currentSession?.session?.id;
  await closeSheet({ clean: true });
  if (sessionId) {
    try { updateProfileAccess(await api().post(`/api/v1/voice-tutor/sessions/${sessionId}/finish`, {})); } catch {}
  }
}

export async function openVoiceTutorError(buttonOrDetails, recoveryEnvelope = null) {
  ensureSheet();
  const details = buttonOrDetails?.dataset ? {
    source: buttonOrDetails.dataset.source || '',
    attemptId: buttonOrDetails.dataset.attempt,
    revision: Number(buttonOrDetails.dataset.revision),
    ...(buttonOrDetails.dataset.pronunciationErrorRef
      ? { pronunciationErrorRef: buttonOrDetails.dataset.pronunciationErrorRef }
      : { criterionIndex: buttonOrDetails.dataset.source
        ? Number(buttonOrDetails.dataset.criterionIndex) : undefined }),
  } : buttonOrDetails;
  if (!canStartVoiceTutor() || !details) return;
  const operation = ++sessionOperation;
  cancelInteraction();
  cancelTutorReport();
  if (!recoveryEnvelope) {
    returnFocus = buttonOrDetails?.focus ? buttonOrDetails : browser.document.activeElement;
  }
  const sheet = browser.document.getElementById('voiceTutorSheet');
  sheet.classList.add('open');
  transientCaptions.length = 0;
  text('voiceTutorCaptions', '');
  const sources = browser.document.getElementById('voiceTutorSources');
  if (sources) { sources.replaceChildren(); sources.hidden = true; }
  setTutorReportStatus('idle', '');
  setVoiceTutorUiState('connecting', 'Собираем проверенный контекст ошибки…', { busy: true });
  browser.document.getElementById('voiceTutorClose')?.focus();
  let fingerprint = '';
  try {
    const attemptId = details.source ? Number(details.attemptId) : details.attemptId;
    const body = {
      ...(details.source ? {
        source: details.source,
        ...(details.pronunciationErrorRef
          ? { pronunciationErrorRef: details.pronunciationErrorRef }
          : { criterionIndex: details.criterionIndex }),
      } : {}),
      attemptId,
      revision: details.revision,
    };
    const bodyFingerprint = creationFingerprint(body);
    if (recoveryEnvelope && (recoveryEnvelope.fingerprint !== bodyFingerprint || !recoveryEnvelope.key)) {
      throw Object.assign(new Error('Voice Tutor recovery context changed.'), { code: 'VOICE_TUTOR_RECOVERY_INVALID' });
    }
    const pending = recoveryEnvelope
      ? rememberPendingSessionKey(bodyFingerprint, recoveryEnvelope.key, operation)
      : idempotencyKeyFor(body, operation);
    fingerprint = pending.fingerprint;
    const createKey = pending.key;
    const recovery = Object.freeze({
      details: Object.freeze({ ...details }), fingerprint, key: createKey,
    });
    currentSessionRecovery = recovery;
    let result = await postIdempotentWithNetworkRetry('/api/v1/voice-tutor/sessions', body, createKey, operation);
    if (!operationActive(operation)) {
      if (!pendingKeyClaimedByAnotherOperation(fingerprint, createKey, operation)) await finishCancelledSession(result);
      return;
    }
    if (result.mode === 'voice' && !result.realtime?.ticket && result.realtime?.reissue_url) {
      setVoiceTutorUiState('recovering', 'Восстанавливаем защищённое подключение…', { busy: true });
      const recovered = await postIdempotentWithNetworkRetry(result.realtime.reissue_url, {}, createKey, operation);
      result = recovered.mode === 'local'
        ? { ...result, ...recovered, realtime: null, local_rule: result.capsule.rule }
        : { ...result, nonce: recovered.nonce, realtime: recovered.realtime };
      if (!operationActive(operation)) {
        if (!pendingKeyClaimedByAnotherOperation(fingerprint, createKey, operation)) await finishCancelledSession(result);
        return;
      }
    }
    releasePendingSessionKey(fingerprint, createKey, operation);
    currentSessionRecovery = recovery;
    renderSession(result);
    startTimer();
    if (result.discovery_required) await discoverMissingRule(result, operation);
    else if (result.mode === 'voice') await startMicrophone(operation);
  } catch (error) {
    if (fingerprint && error?.code !== 'NETWORK_ERROR') {
      const key = currentSessionRecovery?.fingerprint === fingerprint ? currentSessionRecovery.key : '';
      releasePendingSessionKey(fingerprint, key, operation);
    }
    if (operationActive(operation)) {
      showVoiceTutorError(error, {
        allowRetry: error?.code === 'NETWORK_ERROR' || Boolean(currentSession?.session?.id),
      });
    }
  }
}

if (browser.document) ensureSheet();
