import { browserRealtimeTransport } from './realtime-transport.js';

const browser = globalThis.window || globalThis;

let currentSession = null;
let returnFocus = null;
let timerId = null;
let mediaStream = null;
let realtimeConnection = null;
let fallbackPending = false;
const transientCaptions = [];
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

export function configureVoiceTutor(options = {}) {
  runtime = { ...runtime, ...options };
}

export function canStartVoiceTutor(profile = browser.__sub) {
  return profile?.entitlements?.voice_tutor === true;
}

export function eventForVoiceTutorState(state, answer = '') {
  if (state === 'diagnose') return { type: 'diagnosis_complete' };
  if (state === 'explain') return { type: 'explanation_complete' };
  if (state === 'micro_check') return { type: 'check_answer', answer: String(answer) };
  if (state === 'transfer_task') return { type: 'transfer_answer', answer: String(answer) };
  return null;
}

function escapedButtonLabel(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function voiceTutorButton({ profile = browser.__sub, source = '', attemptId, revision, criterionChoices } = {}) {
  if (!canStartVoiceTutor(profile)) return '';
  const reviewSource = source === 'writing' || source === 'speaking' ? source : '';
  const validAttempt = reviewSource
    ? Number.isSafeInteger(Number(attemptId)) && Number(attemptId) > 0
    : /^[0-9a-f-]{36}$/iu.test(String(attemptId || ''));
  if (!validAttempt || !Number.isInteger(revision) || revision < 1 || revision > 10_000) return '';
  const sourceAttribute = reviewSource ? ` data-source="${reviewSource}"` : '';
  const safeAttemptId = reviewSource ? Number(attemptId) : String(attemptId);
  if (!reviewSource) {
    return `<button type="button" class="voiceTutorTrigger" data-attempt="${safeAttemptId}" data-revision="${revision}" onclick="openVoiceTutorError(this)">🎙️ Разобрать голосом</button>`;
  }
  const seen = new Set();
  const choices = (Array.isArray(criterionChoices) ? criterionChoices : []).filter((choice) => {
    const label = typeof choice?.label === 'string' ? choice.label.trim() : '';
    if (!Number.isInteger(choice?.index) || choice.index < 0 || choice.index > 20
      || !label || label.length > 160 || seen.has(choice.index)) return false;
    seen.add(choice.index);
    return true;
  });
  return choices.map(({ index, label }) => `<button type="button" class="voiceTutorTrigger"${sourceAttribute} data-attempt="${safeAttemptId}" data-revision="${revision}" data-criterion-index="${index}" onclick="openVoiceTutorError(this)">🎙️ Разобрать: ${escapedButtonLabel(label.trim())}</button>`).join('');
}

export async function registerVoiceTutorError({ module, itemId, revision, learnerAnswer } = {}) {
  if (!canStartVoiceTutor() || !browser.crypto?.randomUUID) return null;
  const attemptId = browser.crypto.randomUUID();
  await api().post('/api/v1/voice-tutor/errors', {
    attemptId,
    module,
    itemId,
    revision,
    learnerAnswer: String(learnerAnswer || '').slice(0, 200),
  });
  return { attemptId, revision };
}

function voiceTutorSlotId(itemId) {
  const value = String(itemId || '');
  if (!/^[a-z0-9.-]{4,120}$/u.test(value)) return '';
  return `voice_tutor_result_${value.replaceAll('.', '_')}`;
}

export function voiceTutorResultSlot(itemId) {
  const id = voiceTutorSlotId(itemId);
  return id ? `<div id="${id}"></div>` : '';
}

export function prepareVoiceTutorContextResult({ module, set, selections } = {}) {
  const questions = set?.qs;
  if (!set?.voice || !Array.isArray(questions) || !Array.isArray(selections)
    || questions.length !== selections.length) return null;
  const answers = questions.map((question, index) => question?.o?.[selections[index]]);
  if (answers.some((answer) => typeof answer !== 'string' || !answer)) return null;
  return {
    module,
    setId: set.voice.id,
    revision: set.voice.revision,
    answers,
    resultSlot(question, index) {
      return question?.voice && selections[index] !== question.a ? voiceTutorResultSlot(question.voice.id) : '';
    },
  };
}

export async function registerVoiceTutorContextResult({ module, setId, revision, answers } = {}) {
  if (!canStartVoiceTutor() || !browser.crypto?.randomUUID) return null;
  const result = await api().post('/api/v1/voice-tutor/context-attempts', {
    attemptId: browser.crypto.randomUUID(),
    module,
    setId,
    revision,
    answers,
  });
  for (const error of result?.errors || []) {
    const slot = browser.document?.getElementById(voiceTutorSlotId(error.item_id));
    if (slot) slot.innerHTML = voiceTutorButton({ attemptId: error.attempt_id, revision: error.revision });
  }
  return result;
}

function ensureSheet() {
  const document = browser.document;
  if (!document || document.getElementById('voiceTutorSheet')) return;
  const style = document.createElement('style');
  style.textContent = `
    .voiceTutorTrigger{width:100%;min-height:48px;margin-top:10px;border:1px solid #F2B197;border-radius:16px;background:#FFF6F1;color:#A63E1D;font:800 14px Manrope,sans-serif;cursor:pointer}
    #voiceTutorSheet{position:fixed;inset:0;z-index:650;display:none}#voiceTutorSheet.open{display:block}
    #voiceTutorSheet .vtBackdrop{position:absolute;inset:0;background:rgba(20,20,30,.58)}
    #voiceTutorSheet .vtPanel{position:absolute;left:50%;bottom:0;transform:translateX(-50%);width:min(100%,430px);max-height:92dvh;overflow:auto;box-sizing:border-box;background:#FFFDFC;border-radius:28px 28px 0 0;padding:16px 18px calc(20px + env(safe-area-inset-bottom));box-shadow:0 -18px 55px rgba(20,20,30,.28)}
    .vtGrip{width:42px;height:5px;border-radius:9px;background:#D9D5D0;margin:0 auto 12px}.vtHead{display:flex;align-items:flex-start;gap:12px}.vtHeadCopy{flex:1}.vtHead h2{margin:0;color:#2B2B2B;font:900 20px Nunito,Manrope,sans-serif}.vtHead p{margin:4px 0 0;color:#6A665F;font:600 12px/1.45 Manrope,sans-serif}.vtClose{width:40px;height:40px;border:0;border-radius:13px;background:#F1F2F4;font-size:22px;cursor:pointer}
    .vtMeta{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.vtPill{padding:5px 9px;border-radius:12px;background:#F1F2F4;color:#545960;font:800 11px Manrope,sans-serif}.vtWarn{background:#FFF1DF;color:#935300}
    .vtCapsule{margin-top:12px;padding:13px;border:1px solid #EEE8E1;border-radius:17px;background:#fff}.vtCapsule b{display:block;color:#2B2B2B;font:800 13px Manrope,sans-serif}.vtCapsule span{display:block;margin-top:5px;color:#666158;font:600 12px/1.5 Manrope,sans-serif}.vtContext{padding:9px 10px;border-radius:12px;background:#F7F4EF;color:#4A453E!important}.vtContext[hidden]{display:none}
    .vtSources{margin-top:10px;padding:11px 13px;border-radius:15px;background:#EEF7F1;color:#285C3C;font:700 12px/1.5 Manrope,sans-serif}.vtSources[hidden]{display:none}.vtSources b{display:block;margin-bottom:4px}.vtSources a{display:block;color:#176B3A;overflow-wrap:anywhere}
    .vtCaptions{min-height:82px;max-height:150px;overflow:auto;margin-top:12px;padding:13px;border-radius:17px;background:#272B31;color:#fff;font:600 13px/1.55 Manrope,sans-serif}.vtCaptions:empty:before{content:'Временные субтитры появятся здесь';color:#BFC4CC}
    .vtControls{display:flex;align-items:center;justify-content:center;gap:10px;margin-top:12px}.vtMic{width:58px;height:58px;border:0;border-radius:50%;background:#F2683F;color:#fff;font-size:24px;cursor:pointer;box-shadow:0 10px 24px rgba(242,104,63,.3)}.vtMic[aria-pressed="true"]{background:#1F8A50}.vtState{flex:1;color:#4F545B;font:800 12px/1.35 Manrope,sans-serif}
    .vtAnswer{display:flex;gap:8px;margin-top:12px}.vtAnswer input{min-width:0;flex:1;height:48px;border:1px solid #DDD7D0;border-radius:15px;padding:0 13px;font:700 14px Manrope,sans-serif}.vtAnswer button,.vtFinish{min-height:48px;border:0;border-radius:15px;padding:0 15px;font:800 13px Manrope,sans-serif;cursor:pointer}.vtAnswer button{background:#F2683F;color:#fff}.vtFinish{width:100%;margin-top:10px;background:#F1F2F4;color:#3F444B}
  `;
  document.head.appendChild(style);
  const sheet = document.createElement('div');
  sheet.id = 'voiceTutorSheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'voiceTutorTitle');
  sheet.innerHTML = `<div class="vtBackdrop"></div><section class="vtPanel"><div class="vtGrip"></div>
    <div class="vtHead"><div class="vtHeadCopy"><h2 id="voiceTutorTitle">Разбор ошибки с ИИ</h2><p>Голос обрабатывается внешним провайдером в реальном времени; аудио и полный transcript не сохраняются.</p></div><button id="voiceTutorClose" class="vtClose" type="button" aria-label="Завершить разбор и вернуться в упражнение">×</button></div>
    <div class="vtMeta"><span id="voiceTutorTimer" class="vtPill" role="timer">0:00</span><span id="voiceTutorQuota" class="vtPill">Остаток уточняется…</span><span class="vtPill">ИИ · не официальный балл ЕГЭ</span></div>
    <div class="vtCapsule"><b id="voiceTutorSkill">Готовим контекст…</b><span id="voiceTutorPrompt"></span><span id="voiceTutorContext" class="vtContext" hidden></span></div>
    <div id="voiceTutorSources" class="vtSources" hidden></div>
    <div id="voiceTutorCaptions" class="vtCaptions" aria-live="polite" aria-atomic="false"></div>
    <div class="vtControls"><button id="voiceTutorMic" class="vtMic" type="button" aria-label="Включить или выключить микрофон" aria-pressed="false">🎙️</button><div id="voiceTutorState" class="vtState" role="status" aria-live="polite">Подключаем репетитора…</div></div>
    <form id="voiceTutorAnswer" class="vtAnswer"><input id="voiceTutorInput" maxlength="200" aria-label="Ответ репетитору" autocomplete="off"><button type="submit">Продолжить</button></form>
    <button id="voiceTutorFinish" class="vtFinish" type="button">Завершить и вернуться в упражнение</button></section>`;
  document.body.appendChild(sheet);
  sheet.querySelector('.vtBackdrop').addEventListener('click', finishVoiceTutor);
  document.getElementById('voiceTutorClose').addEventListener('click', finishVoiceTutor);
  document.getElementById('voiceTutorFinish').addEventListener('click', finishVoiceTutor);
  document.getElementById('voiceTutorMic').addEventListener('click', toggleMicrophone);
  document.getElementById('voiceTutorAnswer').addEventListener('submit', submitTutorStep);
  sheet.addEventListener('keydown', trapSheetFocus);
}

function text(id, value) {
  const element = browser.document?.getElementById(id);
  if (element) element.textContent = String(value ?? '');
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
  const message = result.text_turn?.message || statePrompt(currentSession.session);
  text('voiceTutorState', message);
  addCaption(message);
  const terminal = ['resolved', 'fallback', 'ended'].includes(currentSession.session.state);
  const form = browser.document.getElementById('voiceTutorAnswer');
  if (form) form.style.display = terminal ? 'none' : 'flex';
}

function renderTrustedRuleDiscovery(result) {
  if (result?.provisional !== true || !result.rule?.explanation || !Array.isArray(result.sources)) {
    throw new Error('TRUSTED_RULE_EVIDENCE_INVALID');
  }
  const message = `${result.notice || 'Предварительное правило ожидает проверки преподавателем.'} ${result.rule.explanation}`;
  text('voiceTutorState', message);
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

async function discoverMissingRule(result) {
  text('voiceTutorState', 'Ищем правило в доверенных источниках…');
  const provisional = await api().post('/api/v1/voice-tutor/rule-discoveries', { session_id: result.session.id });
  renderTrustedRuleDiscovery(provisional);
  return provisional;
}

function updateTimer() {
  if (!currentSession?.session) return;
  const end = new Date(currentSession.session.expires_at).getTime();
  const start = new Date(currentSession.session.started_at).getTime();
  const now = runtime.now();
  const elapsed = Math.max(0, Math.floor((now - start) / 1000));
  const remaining = Math.max(0, Math.ceil((end - now) / 1000));
  text('voiceTutorTimer', `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`);
  const timer = browser.document.getElementById('voiceTutorTimer');
  if (timer) timer.classList.toggle('vtWarn', remaining > 0 && remaining <= 60);
  if (remaining === 0 && currentSession.mode === 'voice') void switchToFallback('session_timeout');
}

function startTimer() {
  browser.clearInterval(timerId);
  updateTimer();
  timerId = browser.setInterval(updateTimer, 1_000);
}

function stopMedia() {
  mediaStream?.getTracks?.().forEach((track) => track.stop());
  mediaStream = null;
  realtimeConnection?.close?.();
  realtimeConnection = null;
  const mic = browser.document?.getElementById('voiceTutorMic');
  if (mic) mic.setAttribute('aria-pressed', 'false');
}

async function startMicrophone() {
  try {
    mediaStream = await mediaDevices().getUserMedia({ audio: true });
  } catch {
    await switchToFallback('microphone_unavailable');
    return;
  }
  try {
    const connector = runtime.realtime || browserRealtimeTransport;
    if (!connector?.connect) throw new Error('realtime transport unavailable');
    realtimeConnection = await connector.connect({
      stream: mediaStream,
      credential: currentSession.realtime.credential,
      url: currentSession.realtime.realtime_url,
      session: currentSession.realtime.session,
      onSubtitle: addCaption,
      onStatus: (status) => text('voiceTutorState', status),
      onPedagogicalEvent: advanceTutorSession,
      onFailure: () => { void switchToFallback('provider_unavailable'); },
    });
    await api().post(`/api/v1/voice-tutor/sessions/${currentSession.session.id}/activate`, { nonce: currentSession.nonce });
    realtimeConnection.activate();
    browser.document.getElementById('voiceTutorMic')?.setAttribute('aria-pressed', 'true');
  } catch {
    stopMedia();
    await switchToFallback('provider_unavailable');
  }
}

async function toggleMicrophone() {
  if (mediaStream) {
    stopMedia();
    text('voiceTutorState', 'Микрофон выключен.');
  } else if (currentSession?.mode === 'voice') {
    await startMicrophone();
  }
}

async function switchToFallback(reason = 'microphone_unavailable') {
  if (fallbackPending || !currentSession?.nonce || currentSession.mode !== 'voice') return;
  fallbackPending = true;
  const sessionId = currentSession.session.id;
  const nonce = currentSession.nonce;
  stopMedia();
  try {
    const result = await api().post(`/api/v1/voice-tutor/sessions/${sessionId}/fallback`, { nonce, reason });
    renderSession(result);
  } catch (error) {
    text('voiceTutorState', api().messageFor(error));
  } finally {
    fallbackPending = false;
  }
}

async function submitTutorStep(event) {
  event.preventDefault();
  if (!currentSession?.nonce) return;
  const input = browser.document.getElementById('voiceTutorInput');
  const tutorEvent = eventForVoiceTutorState(currentSession.session.state, input?.value || '');
  if (!tutorEvent) return;
  try {
    await advanceTutorSession(tutorEvent);
    if (input) input.value = '';
  } catch (error) {
    text('voiceTutorState', api().messageFor(error));
  }
}

async function advanceTutorSession(tutorEvent) {
  if (!currentSession?.nonce || !tutorEvent) throw new Error('VOICE_TUTOR_EVENT_INVALID');
  const result = await api().post(`/api/v1/voice-tutor/sessions/${currentSession.session.id}/events`, { nonce: currentSession.nonce, event: tutorEvent });
  renderSession(result);
  return result;
}

function trapSheetFocus(event) {
  if (event.key === 'Escape') { event.preventDefault(); finishVoiceTutor(); return; }
  if (event.key !== 'Tab') return;
  const controls = [...event.currentTarget.querySelectorAll('button,input')].filter((element) => !element.disabled && element.offsetParent !== null);
  if (!controls.length) return;
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && browser.document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && browser.document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function closeSheet() {
  browser.clearInterval(timerId);
  timerId = null;
  stopMedia();
  transientCaptions.length = 0;
  text('voiceTutorCaptions', '');
  const sources = browser.document?.getElementById('voiceTutorSources');
  if (sources) { sources.replaceChildren(); sources.hidden = true; }
  browser.document?.getElementById('voiceTutorSheet')?.classList.remove('open');
  const focus = returnFocus;
  currentSession = null;
  fallbackPending = false;
  returnFocus = null;
  focus?.focus?.();
}

export async function finishVoiceTutor() {
  const sessionId = currentSession?.session?.id;
  closeSheet();
  if (sessionId) {
    try { await api().post(`/api/v1/voice-tutor/sessions/${sessionId}/finish`, {}); } catch {}
  }
}

export async function openVoiceTutorError(buttonOrDetails) {
  ensureSheet();
  const details = buttonOrDetails?.dataset ? {
    source: buttonOrDetails.dataset.source || '',
    attemptId: buttonOrDetails.dataset.attempt,
    revision: Number(buttonOrDetails.dataset.revision),
    criterionIndex: buttonOrDetails.dataset.source ? Number(buttonOrDetails.dataset.criterionIndex) : undefined,
  } : buttonOrDetails;
  if (!canStartVoiceTutor() || !details) return;
  returnFocus = buttonOrDetails?.focus ? buttonOrDetails : browser.document.activeElement;
  const sheet = browser.document.getElementById('voiceTutorSheet');
  sheet.classList.add('open');
  transientCaptions.length = 0;
  text('voiceTutorState', 'Собираем проверенный контекст ошибки…');
  browser.document.getElementById('voiceTutorClose')?.focus();
  try {
    const attemptId = details.source ? Number(details.attemptId) : details.attemptId;
    const body = {
      ...(details.source ? { source: details.source, criterionIndex: details.criterionIndex } : {}),
      attemptId,
      revision: details.revision,
    };
    const result = await api().postIdempotent('/api/v1/voice-tutor/sessions', body, browser.crypto.randomUUID());
    renderSession(result);
    startTimer();
    if (result.discovery_required) await discoverMissingRule(result);
    else if (result.mode === 'voice') await startMicrophone();
  } catch (error) {
    text('voiceTutorState', api().messageFor(error));
  }
}

if (browser.document) ensureSheet();
