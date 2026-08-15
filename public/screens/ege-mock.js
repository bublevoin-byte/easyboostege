import { loadEgeMockPublicForm } from '../ege-mock-catalog-contract.js';
import { createEgeMockAssetPreflight, egeMockAssetPlaybackUrl } from '../ege-mock-written-assets.js';
import { egeMockWrittenInvalidationKey } from '../ege-mock-written-continuation.js';
import { createEgeMockWrittenRunner, normalizeEgeMockSelection } from '../ege-mock-written-runner.js';
import { createEgeMockOralRunner } from '../ege-mock-oral-runner.js';
import { createEgeMockOralMedia } from '../ege-mock-oral-media.js';
import {
  EGE_MOCK_ORAL_POSITIONS,
  EGE_MOCK_ORAL_TASK_BY_POSITION,
  EGE_MOCK_ORAL_TASKS,
} from '../ege-mock-oral-contract.js';
import { countEgeWritingWords, sanitizeEgeWritingText } from '../ege-writing-text.js';
import {
  renderEgeMockWritingAssessmentActions,
  renderEgeMockWritingAssessmentStatus,
} from '../ege-mock-writing-assessment-ui.js';
import { AUTOMATIC_ASSESSMENT_WARNING } from '../automatic-assessment-contract.js';
import {
  apiGet, apiIsAuthorityFailure, apiMessage, apiPost, apiPostBinary, apiPostIdempotent, apiPut,
  apiResponseOwner, apiResponseServerTime,
  commitEgeMockOwnerMutation,
  currentEgeMockOwnerBinding, invalidateLearningAuthority, listeningModule, readingModule,
  registerAuthorityReset,
} from '../app.js';
import { registerRouteHook } from '../router.js';

const SECTION_LABELS = Object.freeze({
  listening: 'Аудирование', reading: 'Чтение', grammar_lexis: 'Грамматика и лексика',
  writing: 'Письменная речь',
});
const SECTION_STARTS = Object.freeze({ listening: 1, reading: 10, grammar_lexis: 19, writing: 37 });
const ORAL_WARNING_MINUTES = Object.freeze([10, 5, 1]);

let runner = null;
let runnerOwnerKey = '';
let runnerStorageKey = '';
let runnerInvalidationKey = '';
let form = null;
let timer = null;
let autosave = null;
let opening = null;
let openingOwnerKey = '';
let openEpoch = 0;
let announcedWarning = null;
let announcedOralWarning = null;
let visibleError = '';
let retryAt = 0;
let oralRunner = null;
let oralMedia = null;
let oralOpening = null;
let oralTimer = null;
let oralCaptured = null;
let oralRecordingActive = false;
let oralAssessing = false;
let oralProviderRepeatAckRequired = false;
let oralStorageKey = '';
let oralRetryAt = 0;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function ownerKey(owner) { return owner ? `${owner.username}\u0000${owner.generation}` : ''; }

function hasLocalOralState(owner) {
  return localStorage.getItem(
    `easyboost-ege-mock-oral-v1:${owner.username}:${owner.generation}`,
  ) != null;
}

function openOperationCurrent(operation) {
  return operation?.epoch === openEpoch
    && operation.ownerKey === ownerKey(currentEgeMockOwnerBinding())
    && document.getElementById('scr16')?.classList.contains('on');
}

function currentRunnerOperation() {
  return runner ? {
    epoch: openEpoch, ownerKey: runnerOwnerKey, owner: currentEgeMockOwnerBinding(),
    runner, form, storageKey: runnerStorageKey,
  } : null;
}

function runnerOperationCurrent(operation) {
  return openOperationCurrent(operation) && operation.runner === runner && operation.form === form;
}

function oralOperationCurrent(operation) {
  return openOperationCurrent(operation) && operation.writtenRunner === runner
    && operation.form === form && operation.attemptId === runner?.snapshot().attemptId;
}

function ownerHeaders(owner) { return { 'X-EasyBoost-Expected-Owner': owner.username }; }

function assertOwnedResponse(result, owner) {
  if (apiResponseOwner(result) !== owner.username) throw Object.assign(new Error('OWNER_CHANGED'), {
    code: 'OWNER_CHANGED', status: 409,
  });
  return result;
}

function timedOwnedResponse(result, owner) {
  const owned = assertOwnedResponse(result, owner);
  const serverTimeMs = apiResponseServerTime(owned);
  if (!Number.isFinite(serverTimeMs)) throw new Error('EGE_MOCK_SERVER_TIME_REQUIRED');
  return { ...owned, serverTimeMs };
}

async function handleRunnerError(error, operation = currentRunnerOperation()) {
  if (operation && !openOperationCurrent(operation)) return true;
  const invalidation = await discardMissingAttempt(error, operation);
  if (invalidation === 'discarded') { renderDiscardedAttempt(); return true; }
  if (invalidation === 'unavailable') { renderUnavailableAttempt(); return true; }
  if (invalidation === 'handled') return true;
  const binding = currentEgeMockOwnerBinding();
  if (binding && (!operation || ownerKey(binding) === operation.ownerKey) && apiIsAuthorityFailure(error)) {
    resetRunner();
    await invalidateLearningAuthority({ owner: binding.username, ownerGeneration: binding.generation });
    return true;
  }
  if (operation && !openOperationCurrent(operation)) return true;
  visibleError = apiMessage(error);
  return false;
}

function transportFor(owner) {
  return Object.freeze({
    async attempt(attemptId) {
      return timedOwnedResponse(await apiGet(`/api/v1/ege-mocks/attempts/${attemptId}`, {
        headers: ownerHeaders(owner),
      }), owner);
    },
    async current() {
      return timedOwnedResponse(await apiGet('/api/v1/ege-mocks/attempts/current', {
        headers: ownerHeaders(owner),
      }), owner);
    },
    async start(input) {
      return timedOwnedResponse(await apiPostIdempotent('/api/v1/ege-mocks/attempts', {
        formId: input.formId, formRevision: input.formRevision,
        catalogFingerprint: input.catalogFingerprint,
      }, input.idempotencyKey, ownerHeaders(owner)), owner);
    },
    async saveDraft(input) {
      return timedOwnedResponse(await apiPut(`/api/v1/ege-mocks/attempts/${input.attemptId}/draft`, {
        expectedRevision: input.expectedRevision, answers: input.answers,
      }, { ...ownerHeaders(owner), 'Idempotency-Key': input.idempotencyKey }), owner);
    },
    async submitWritten(input) {
      return timedOwnedResponse(await apiPostIdempotent(
        `/api/v1/ege-mocks/attempts/${input.attemptId}/written/submit`,
        { expectedRevision: input.expectedRevision }, input.idempotencyKey, ownerHeaders(owner),
      ), owner);
    },
    async runAssessment(input) {
      return timedOwnedResponse(await apiPostIdempotent(
        `/api/v1/ege-mocks/attempts/${input.attemptId}/assessment/run`,
        input.explicitRenewal === true ? { explicitRenewal: true } : {},
        input.idempotencyKey, ownerHeaders(owner),
      ), owner);
    },
    async retryAssessment(input) {
      return timedOwnedResponse(await apiPostIdempotent(
        `/api/v1/ege-mocks/attempts/${input.attemptId}/assessment/retry`,
        input.acknowledgePossibleProviderRepeat
          ? { acknowledgePossibleProviderRepeat: true } : {},
        input.idempotencyKey, ownerHeaders(owner),
      ), owner);
    },
  });
}

function oralTransportFor(owner, attemptId) {
  return Object.freeze({
    async attempt(candidateId) {
      return timedOwnedResponse(await apiGet(
        `/api/v1/ege-mocks/attempts/${candidateId || attemptId}`,
        { headers: ownerHeaders(owner) },
      ), owner);
    },
    async start(candidateId, input) {
      return timedOwnedResponse(await apiPostIdempotent(
        `/api/v1/ege-mocks/attempts/${candidateId}/oral/start`,
        { expectedRevision: input.expectedRevision }, input.idempotencyKey, ownerHeaders(owner),
      ), owner);
    },
    async stage(candidateId, input) {
      const { idempotencyKey, ...body } = input;
      return timedOwnedResponse(await apiPostIdempotent(
        `/api/v1/ege-mocks/attempts/${candidateId}/oral/stage`,
        body, idempotencyKey, ownerHeaders(owner),
      ), owner);
    },
    async submit(candidateId, input) {
      return timedOwnedResponse(await apiPostIdempotent(
        `/api/v1/ege-mocks/attempts/${candidateId}/oral/submit`,
        { expectedRevision: input.expectedRevision },
        input.idempotencyKey, ownerHeaders(owner),
      ), owner);
    },
  });
}

function stopTimers() {
  if (timer) clearInterval(timer);
  if (autosave) clearTimeout(autosave);
  timer = null;
  autosave = null;
  if (oralTimer) clearInterval(oralTimer);
  oralTimer = null;
}

function clearPrivateRunnerDom() {
  const area = document.getElementById('ege_mock_area');
  if (!area) return;
  area.replaceChildren();
  area.insertAdjacentHTML('afterbegin', '<section class="ege-mock__card"><h2>Сессия обновлена</h2><p>Откройте пробник снова после входа.</p></section>');
}

function resetRunnerState(keepOpening = false, invalidateOpening = true) {
  if (invalidateOpening) openEpoch += 1;
  stopTimers();
  clearPrivateRunnerDom();
  runner = null;
  runnerOwnerKey = '';
  runnerStorageKey = '';
  runnerInvalidationKey = '';
  oralMedia?.dispose?.();
  oralRunner = null;
  oralMedia = null;
  oralOpening = null;
  oralCaptured = null;
  oralRecordingActive = false;
  oralAssessing = false;
  oralProviderRepeatAckRequired = false;
  oralStorageKey = '';
  oralRetryAt = 0;
  form = null;
  if (!keepOpening) {
    opening = null;
    openingOwnerKey = '';
  }
  announcedWarning = null;
  announcedOralWarning = null;
  visibleError = '';
  document.getElementById('frame')?.classList.remove('ege-mock-expanded');
}

function resetRunner() { resetRunnerState(); }

async function discardMissingAttempt(error, operation = null) {
  const discarded = error?.code === 'EGE_MOCK_ATTEMPT_NOT_FOUND'
    || error?.code === 'EGE_MOCK_ATTEMPT_OWNER_CHANGED'
    || error?.code === 'EGE_MOCK_WRITTEN_LOCAL_STATE_INVALIDATED'
    || error?.message === 'EGE_MOCK_WRITTEN_LOCAL_STATE_INVALID';
  if (!discarded) return false;
  if (operation && !openOperationCurrent(operation)) return false;
  if (error?.code !== 'EGE_MOCK_WRITTEN_LOCAL_STATE_INVALIDATED') {
    if (!operation?.runner) return false;
    try { await operation.runner.dispatch({ type: 'invalidate' }); } catch (invalidationError) {
      if (!openOperationCurrent(operation)) return 'handled';
      if (invalidationError?.code !== 'EGE_MOCK_WRITTEN_LOCAL_STATE_INVALIDATED') {
        visibleError = apiMessage(invalidationError);
        return 'unavailable';
      }
    }
  }
  if (operation && !openOperationCurrent(operation)) return 'handled';
  resetRunnerState(true, false);
  visibleError = apiMessage(error);
  return 'discarded';
}

function renderDiscardedAttempt() {
  const area = document.getElementById('ege_mock_area');
  if (!area) return;
  area.innerHTML = `<p class="ege-mock__error" role="alert">${escapeHtml(visibleError)}</p><section class="ege-mock__card ege-mock__intro"><h2>Старая попытка закрыта</h2><p>Локальные ответы относились к другой версии аккаунта или к удалённой попытке и были безопасно скрыты.</p><button class="ege-mock__action" type="button" data-ege-action="retry-open">Открыть актуальный пробник</button></section>`;
}

function renderUnavailableAttempt() {
  stopTimers();
  runner = null;
  runnerOwnerKey = '';
  runnerStorageKey = '';
  runnerInvalidationKey = '';
  form = null;
  document.getElementById('frame')?.classList.add('ege-mock-expanded');
  const area = document.getElementById('ege_mock_area');
  if (!area) return;
  area.innerHTML = `<p class="ege-mock__error" role="alert">${escapeHtml(visibleError)}</p><section class="ege-mock__card ege-mock__intro"><h2>Состояние попытки не подтверждено</h2><p>Состояние попытки не удалось подтвердить. Редактирование и новый старт заблокированы, пока сервер не ответит однозначно.</p><button class="ege-mock__action" type="button" data-ege-action="retry-open">Повторить проверку</button></section>`;
}

function sectionFor(position) {
  return form.positions[position - 1].section;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  const remainder = value % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function renderTimer(snapshot) {
  const part = document.getElementById('ege_mock_part');
  if (part) part.textContent = 'ЕГЭ-2026 · ПИСЬМЕННАЯ ЧАСТЬ';
  const element = document.getElementById('ege_mock_timer');
  if (!element) return;
  const running = ['running', 'writing', 'asset_blocked', 'objective_queued', 'objective_completed', 'submit_queued'].includes(snapshot.phase);
  element.innerHTML = `${running ? formatTime(snapshot.remainingSeconds) : '—'}<small>${running ? 'до сдачи' : '190 минут'}</small>`;
  const warning = running && snapshot.timerWarningMinutes != null;
  element.classList.toggle('ege-mock__timer--warning', warning);
  element.setAttribute('aria-live', 'off');
  element.setAttribute('aria-label', running ? `До автоматической сдачи ${formatTime(snapshot.remainingSeconds)}` : 'Таймер не запущен');
  const notice = document.getElementById('ege_mock_timer_notice');
  if (notice && snapshot.timerWarningMinutes !== announcedWarning) {
    announcedWarning = snapshot.timerWarningMinutes;
    notice.textContent = announcedWarning == null ? '' : `До автоматической сдачи осталось ${announcedWarning} минут`;
  }
}

function oralAuthorityNow(snapshot) {
  const value = Number(snapshot.authorityNowMs);
  if (!Number.isFinite(value)) throw new Error('EGE_MOCK_ORAL_TIMER_AUTHORITY_INVALID');
  return value;
}

function oralTimerWarningMinutes(snapshot) {
  if (snapshot?.phase !== 'oral' || !Number.isFinite(Number(snapshot.remainingMs))) return null;
  return ORAL_WARNING_MINUTES.filter(
    (minutes) => Number(snapshot.remainingMs) <= minutes * 60_000,
  ).at(-1) ?? null;
}

function renderOralHeader(snapshot) {
  const part = document.getElementById('ege_mock_part');
  if (part) part.textContent = 'ЕГЭ-2026 · УСТНАЯ ЧАСТЬ';
  const element = document.getElementById('ege_mock_timer');
  if (!element) return;
  const running = snapshot?.phase === 'oral';
  const remainingSeconds = running ? Math.ceil(Number(snapshot.remainingMs) / 1_000) : null;
  element.innerHTML = `${running ? formatTime(remainingSeconds) : '—'}<small>${running ? 'до сдачи' : '17 минут'}</small>`;
  element.setAttribute('role', 'timer');
  element.setAttribute('aria-live', 'off');
  element.setAttribute('aria-label', running
    ? `До автоматической сдачи устной части ${formatTime(remainingSeconds)}`
    : 'Таймер устной части не запущен');
  const warning = oralTimerWarningMinutes(snapshot);
  element.classList.toggle('ege-mock__timer--warning', warning != null);
  const notice = document.getElementById('ege_mock_timer_notice');
  if (notice && warning !== announcedOralWarning) {
    announcedOralWarning = warning;
    notice.textContent = warning == null ? ''
      : `До автоматической сдачи устной части осталось ${warning} минут`;
  }
}

function introMarkup(snapshot) {
  const working = snapshot.phase === 'preflighting';
  const ready = snapshot.phase === 'ready';
  return `${visibleError ? `<p class="ege-mock__error" role="alert">${escapeHtml(visibleError)}</p>` : ''}<section class="ege-mock__card ege-mock__intro">
    <p class="ege-mock__status" role="status">${working ? 'Проверяем и сохраняем 20 аудиофайлов…' : ready ? 'Техническая проверка завершена. Таймер ещё не запущен.' : 'Один эталонный авторский вариант по структуре ЕГЭ-2026.'}</p>
    <h2>Задания 1–38 в единой строгой письменной части</h2>
    <p>До старта приложение загрузит и сверит все записи. После запуска сервер отсчитает 190 минут: перезагрузка и отсутствие сети не ставят время на паузу.</p>
    <div class="ege-mock__facts">
      <div class="ege-mock__fact"><strong>38</strong> заданий, включая письмо и эссе</div>
      <div class="ege-mock__fact"><strong>190 мин</strong> общий письменный таймер</div>
      <div class="ege-mock__fact"><strong>20 аудио</strong> exact digest preflight</div>
      <div class="ege-mock__fact"><strong>Без подсказок</strong> ключи и баллы скрыты</div>
    </div>
    ${ready
      ? '<button class="ege-mock__action" type="button" data-ege-action="start">Начать письменную часть</button>'
      : `<button class="ege-mock__action" type="button" data-ege-action="prepare" ${working ? 'disabled' : ''}>${working ? 'Проверяем файлы…' : 'Проверить готовность'}</button>`}
  </section>`;
}

function optionMarkup(options, selected, name) {
  return `<div class="ege-mock__choices">${options.map((option) => `<label class="ege-mock__choice">
    <input type="radio" name="${escapeHtml(name)}" value="${escapeHtml(option.id)}" aria-label="${escapeHtml(option.text)}" ${selected === option.id ? 'checked' : ''}>
    <span>${escapeHtml(option.text)}</span></label>`).join('')}</div>`;
}

function arrayFields(item, answer, count, labels, options) {
  const values = Array.isArray(answer) ? answer : [];
  return `<div class="ege-mock__fields">${Array.from({ length: count }, (_, index) => `<label class="ege-mock__field">
    <span>${escapeHtml(labels[index] || `Ответ ${index + 1}`)}</span>
    <select data-ege-array-index="${index}" aria-label="Ответ ${index + 1} в задании ${item.position}">
      <option value="">Не выбрано</option>${options.map((option) => `<option value="${escapeHtml(option.id)}" ${values[index] === option.id ? 'selected' : ''}>${escapeHtml(option.id)} · ${escapeHtml(option.text)}</option>`).join('')}
    </select></label>`).join('')}</div>`;
}

function audioGroup(item) {
  if (item.presentation.kind === 'listening_matching') return 'matching';
  if (item.presentation.kind === 'listening_true_false') return 'true_false';
  return 'interview';
}

function audioMarkup(item, snapshot) {
  if (!item.assetIds.length) return '';
  const group = audioGroup(item);
  const used = snapshot.audioPlays[group] || 0;
  return `<section class="ege-mock__audio" aria-label="Экзаменационная запись">
    <p>Запись можно включить дважды. Осталось: <strong>${Math.max(0, 2 - used)}</strong></p>
    <button type="button" class="ege-mock__action ege-mock__action--secondary" data-ege-audio-play="${group}" ${used >= 2 || snapshot.audioInFlight ? 'disabled' : ''}>Воспроизвести запись</button>
    ${item.assetIds.map((path, index) => `<audio hidden preload="auto" data-ege-audio-segment src="${escapeHtml(egeMockAssetPlaybackUrl(form, path))}" aria-label="Задание ${item.position}, аудиофрагмент ${index + 1}"></audio>`).join('')}</section>`;
}

function stimulusMarkup(item) {
  const id = item.presentation.stimulusId;
  const stimulus = form.stimuli.find((candidate) => candidate.id === id);
  if (!stimulus) return '';
  if (stimulus.kind === 'reading_passage') return `<article class="ege-mock__stimulus">${escapeHtml(stimulus.text)}</article>`;
  if (stimulus.kind === 'gap_passage') {
    const fragments = stimulus.fragments.map(escapeHtml);
    return `<article class="ege-mock__stimulus">${fragments.join(' <strong aria-label="пропуск">_____</strong> ')}</article>`;
  }
  return '';
}

function taskFields(item, answer) {
  const presentation = item.presentation;
  if (presentation.kind === 'listening_matching') {
    const options = presentation.statements.map((text, index) => ({ id: String(index + 1), text }));
    return arrayFields(item, answer, item.assetIds.length,
      item.assetIds.map((_, index) => `Говорящий ${String.fromCharCode(65 + index)}`), options);
  }
  if (presentation.kind === 'listening_true_false') {
    return arrayFields(item, answer, presentation.statements.length, presentation.statements, presentation.options);
  }
  if (presentation.kind === 'reading_headings') {
    return `${presentation.texts.map((text) => `<article class="ege-mock__stimulus"><strong>${escapeHtml(text.id)}</strong> · ${escapeHtml(text.text)}</article>`).join('')}${arrayFields(item, answer, presentation.texts.length, presentation.texts.map((text) => `Текст ${text.id}`), presentation.options)}`;
  }
  if (presentation.kind === 'reading_gaps') {
    return `<article class="ege-mock__stimulus">${presentation.segments.map(escapeHtml).join(' <strong aria-label="пропуск">_____</strong> ')}</article>${arrayFields(item, answer, presentation.segments.length - 1, presentation.segments.slice(0, -1).map((_, index) => `Пропуск ${index + 1}`), presentation.options)}`;
  }
  if (['listening_choice', 'reading_choice', 'lexical_choice'].includes(presentation.kind)) {
    return `${stimulusMarkup(item)}<p class="ege-mock__prompt"><strong>${escapeHtml(presentation.prompt)}</strong></p>${optionMarkup(presentation.options, answer, `ege-${item.position}`)}`;
  }
  if (['grammar_form', 'word_formation'].includes(presentation.kind)) {
    const prompt = presentation.prompt || `Поставьте слово ${presentation.base} в нужную форму.`;
    return `${stimulusMarkup(item)}<label class="ege-mock__field"><span>${escapeHtml(prompt)}</span><input type="text" data-ege-text value="${escapeHtml(answer || '')}" autocomplete="off" spellcheck="false" aria-label="Ответ на задание ${item.position}"><small>Исходное слово: ${escapeHtml(presentation.base)}</small></label>`;
  }
  if (presentation.kind === 'writing_email') {
    return `<article class="ege-mock__stimulus"><strong>Письмо от ${escapeHtml(presentation.from)}</strong><p>${escapeHtml(presentation.stimulus)}</p></article>
      <p class="ege-mock__prompt">Ответьте на три вопроса и задайте три вопроса по теме «${escapeHtml(presentation.questionsTopic)}».</p>
      <p class="ege-mock__status"><strong>Объём: 100–140 слов.</strong> ${escapeHtml(AUTOMATIC_ASSESSMENT_WARNING)}</p>
      <label class="ege-mock__field"><span>Ваш ответ на задание 37</span><textarea data-ege-writing maxlength="12000" spellcheck="true" aria-label="Ответ на задание 37" aria-describedby="ege_mock_word_count">${escapeHtml(answer || '')}</textarea><small id="ege_mock_word_count" role="status">Слов: ${countEgeWritingWords(sanitizeEgeWritingText(answer), { taskType: 'writing_37', assignment: presentation })}</small></label>`;
  }
  if (presentation.kind === 'writing_report') {
    return `<article class="ege-mock__stimulus"><strong>${escapeHtml(presentation.topic)}</strong><table><tbody>${presentation.rows.map((row) => `<tr><th scope="row">${escapeHtml(row.label)}</th><td>${row.percent}%</td></tr>`).join('')}</tbody></table></article>
      <p class="ege-mock__prompt">Опишите 2–3 факта, сравните данные, обозначьте проблему и решение, завершите обоснованным мнением.</p>
      <p class="ege-mock__status"><strong>Объём: 200–250 слов.</strong> ${escapeHtml(AUTOMATIC_ASSESSMENT_WARNING)}</p>
      <label class="ege-mock__field"><span>Ваш ответ на задание 38</span><textarea data-ege-writing maxlength="20000" spellcheck="true" aria-label="Ответ на задание 38" aria-describedby="ege_mock_word_count">${escapeHtml(answer || '')}</textarea><small id="ege_mock_word_count" role="status">Слов: ${countEgeWritingWords(sanitizeEgeWritingText(answer), { taskType: 'writing_38', assignment: presentation })}</small></label>`;
  }
  return '<p class="ege-mock__error">Формат задания не поддерживается.</p>';
}

function writingCriteriaMarkup(kind) {
  const criteria = kind === 'writing_email'
    ? 'решение коммуникативной задачи, организация текста и языковое оформление'
    : kind === 'writing_report'
      ? 'решение коммуникативной задачи, организация, лексика, грамматика, орфография и пунктуация'
      : null;
  return criteria
    ? `<p class="ege-mock__criteria" aria-label="Критерии оценивания"><strong>Оцениваются:</strong> ${criteria}.</p>`
    : '';
}

function runningMarkup(snapshot) {
  const item = form.positions[snapshot.currentPosition - 1];
  const section = sectionFor(snapshot.currentPosition);
  const answer = snapshot.answers[String(snapshot.currentPosition)];
  const previous = snapshot.currentPosition - 1;
  const next = snapshot.currentPosition + 1;
  const writingPhase = snapshot.phase === 'writing';
  const positionCount = writingPhase ? 38 : 36;
  const answeredCount = writingPhase ? snapshot.writtenAnsweredCount : snapshot.answeredCount;
  const blankPositions = writingPhase ? snapshot.writtenBlankPositions : snapshot.blankPositions;
  const sectionEntries = Object.entries(SECTION_STARTS).filter(([id]) => writingPhase || id !== 'writing');
  const finish = writingPhase
    ? `Сдать письменную часть${blankPositions.length ? ` · пропущено ${blankPositions.length}` : ''}`
    : `Завершить задания 1–36${blankPositions.length ? ` · пропущено ${blankPositions.length}` : ''}`;
  const writingDraftRecovery = snapshot.writingDraftRecovery?.positions?.length
    ? `<p class="ege-mock__status" role="status">Черновик задания ${snapshot.writingDraftRecovery.positions.join(', ')} восстановлен из устаревшего формата. Проверьте его перед сдачей.</p>` : '';
  return `${visibleError ? `<p class="ege-mock__error" role="alert">${escapeHtml(visibleError)}</p>` : ''}${writingDraftRecovery}<div class="ege-mock__layout">
    <aside class="ege-mock__side">
      <section class="ege-mock__card ege-mock__progress"><p><span>Заполнено</span><strong>${answeredCount} из ${positionCount}</strong></p><progress max="${positionCount}" value="${answeredCount}"></progress><p id="ege_mock_save" role="status"><span>Сохранение</span><strong>${snapshot.saveStatus === 'saved' ? 'на сервере' : snapshot.saveStatus === 'queued' ? 'в очереди' : 'локально'}</strong></p></section>
      <nav class="ege-mock__card" aria-label="Разделы"><div class="ege-mock__sections">${sectionEntries.map(([id, start]) => `<button type="button" data-ege-position="${start}" aria-current="${id === section}">${SECTION_LABELS[id]}</button>`).join('')}</div><div class="ege-mock__review" aria-label="Обзор ответов">${Array.from({ length: positionCount }, (_, index) => { const position = index + 1; const blank = blankPositions.includes(position); return `<button type="button" data-ege-position="${position}" data-blank="${blank}" aria-current="${position === snapshot.currentPosition}" aria-label="Задание ${position}${blank ? ', пропущено' : ', отвечено'}">${position}</button>`; }).join('')}</div></nav>
    </aside>
    <section class="ege-mock__card ege-mock__task">
      <header class="ege-mock__task-head"><div><p>${SECTION_LABELS[section]}</p><h2 tabindex="-1">Задание ${item.position}</h2></div><p>Ответ сохраняется</p></header>
      ${audioMarkup(item, snapshot)}${writingCriteriaMarkup(item.presentation.kind)}${taskFields(item, answer)}
      <div class="ege-mock__nav"><button class="ege-mock__action ege-mock__action--secondary" type="button" data-ege-position="${previous}" ${previous < 1 ? 'disabled' : ''}>Назад</button><button class="ege-mock__action" type="button" data-ege-position="${next}" ${next > positionCount ? 'disabled' : ''}>Далее</button><button class="ege-mock__action ege-mock__action--secondary ege-mock__submit" type="button" data-ege-action="${writingPhase ? 'complete-written' : 'complete-objective'}">${finish}</button></div>
    </section>
  </div>`;
}

function oralTaskMarkup(snapshot) {
  const current = snapshot.current;
  if (!current) return '';
  const item = form.positions[current.position - 1];
  const presentation = item.presentation;
  if (current.position === 39) {
    return `<p>${escapeHtml(presentation.instruction)}</p><article class="ege-mock__stimulus">${escapeHtml(presentation.text)}</article>`;
  }
  if (current.position === 40) {
    return `<p>${escapeHtml(presentation.instruction)}</p><article class="ege-mock__stimulus"><strong>${escapeHtml(presentation.advertisement)}</strong><ul>${presentation.supports.map((entry) => `<li>${escapeHtml(entry)}</li>`).join('')}</ul></article>`;
  }
  if (current.position === 41) {
    return `<p>${escapeHtml(presentation.instruction)}</p><article class="ege-mock__stimulus"><strong>Вопрос ${current.responseNumber} из ${EGE_MOCK_ORAL_TASK_BY_POSITION[41].responseCount}</strong><p>${escapeHtml(presentation.questions[current.responseNumber - 1])}</p></article>`;
  }
  const pair = presentation.photoPair;
  const verifiedPairUrl = oralMedia.assetUrl(pair.src);
  return `<p>${escapeHtml(presentation.instruction)}</p><article class="ege-mock__stimulus"><strong>${escapeHtml(presentation.projectTitle)}</strong><div class="ege-mock__oral-photos"><img src="${escapeHtml(verifiedPairUrl)}" alt="${escapeHtml(pair.alt)}"></div><ol>${presentation.plan.map((entry) => `<li>${escapeHtml(entry)}</li>`).join('')}</ol></article>`;
}

function oralMarkup(snapshot) {
  const warning = `<p class="ege-mock__status"><strong>Оценка речи предварительная.</strong> ${escapeHtml(AUTOMATIC_ASSESSMENT_WARNING)}</p>`;
  if (snapshot.phase === 'ready') return `<section class="ege-mock__card ege-mock__success"><h2>Письменная часть сдана</h2><p>Устную часть можно начать после проверки микрофона и фотографий. Отдельные 17 минут начнутся только после этой проверки.</p>${warning}<button class="ege-mock__action" type="button" data-ege-action="oral-preflight">Проверить микрофон и материалы</button></section>`;
  if (snapshot.phase === 'prepared') return `<section class="ege-mock__card ege-mock__success"><h2>Устная часть готова</h2><p>Микрофон и материалы доступны. После старта таймер нельзя поставить на паузу.</p><button class="ege-mock__action" type="button" data-ege-action="oral-start">Начать 17 минут</button></section>`;
  if (snapshot.phase === 'submitted') {
    const assessment = snapshot.speakingAssessment;
    const rows = Object.values(assessment?.items || {}).map((item) => `<li>Задание ${item.position}: ${item.score == null ? '—' : item.score} из ${item.maximum} · ${escapeHtml(item.status)}</li>`).join('');
    const localReady = snapshot.assessmentEvidenceReady === true;
    const assessmentAction = oralProviderRepeatAckRequired
      ? '<p class="ege-mock__error" role="alert">Предыдущий вызов провайдера мог состояться. Повтор может создать ещё один платный вызов.</p><button class="ege-mock__action" type="button" data-ege-action="oral-assess-repeat">Повторить, понимаю риск повторного платного вызова</button>'
      : assessment?.status === 'completed'
      ? `<p role="status">Ориентировочная оценка готова.</p><ul>${rows}</ul>`
      : assessment?.status === 'retryable'
        ? `<p class="ege-mock__error" role="alert">Данных одной или нескольких записей недостаточно. Нулевой балл за недоступное доказательство не выставлен.</p><ul>${rows}</ul>`
        : `<p role="status">Оценка запускается только отдельным явным действием. Записи обработает внешний сервис; обычный исходный звук сервер приложения не сохраняет.</p><button class="ege-mock__action" type="button" data-ege-action="oral-assess" ${oralAssessing || !localReady ? 'disabled' : ''}>${oralAssessing ? 'Получаем примерную оценку…' : localReady ? 'Получить примерную автоматическую оценку' : 'Локальные записи недоступны'}</button>`;
    return `<section class="ege-mock__card ege-mock__success"><h2>Устная часть сдана</h2>${visibleError ? `<p class="ege-mock__error" role="alert">${escapeHtml(visibleError)}</p>` : ''}${warning}<p>Записи привязаны к этой попытке. Сбой или неоднозначный ответ провайдера не создаст повторную платную оценку при перезагрузке.</p>${assessmentAction}</section>`;
  }
  if (snapshot.phase === 'expired') return '<section class="ege-mock__card ege-mock__error" role="alert"><h2>Устная часть завершена по времени</h2><p>Сервер закрыл отдельные 17 минут. Уже подтверждённые ответы сохранены.</p></section>';
  if (snapshot.phase !== 'oral') return '<section class="ege-mock__card"><p role="status">Восстанавливаем устную часть…</p></section>';
  if (snapshot.readyToSubmit) return `<section class="ege-mock__card ege-mock__success"><h2>Все задания 39–42 пройдены</h2>${warning}<button class="ege-mock__action" type="button" data-ege-action="oral-submit">Сдать устную часть</button></section>`;
  const current = snapshot.current;
  const stage = current.phase === 'ready' ? 'ГОТОВО' : current.phase === 'preparing' ? 'ПОДГОТОВКА' : '● ЗАПИСЬ';
  const stageRemaining = current.stageDeadlineAt
    ? Math.max(0, Math.ceil(
      (new Date(current.stageDeadlineAt).getTime() - oralAuthorityNow(snapshot)) / 1000,
    )) : null;
  const limit = EGE_MOCK_ORAL_TASK_BY_POSITION[current.position].responseSeconds;
  const captureOwned = oralMedia?.hasRecordingLease?.() === true;
  const controls = current.phase === 'ready'
    ? captureOwned
      ? '<button class="ege-mock__action" type="button" data-ege-action="oral-advance">Начать этап</button>'
      : '<p role="status">Запись активна в другой вкладке. Здесь отображается подтверждённый прогресс.</p><button class="ege-mock__action" type="button" disabled>Начать этап</button>'
    : current.phase === 'preparing'
      ? '<p role="status">Подготовка идёт до серверного дедлайна. Запись начнётся автоматически.</p>'
      : oralCaptured
        ? `<p role="status">Запись завершена автоматически: ${Math.round(oralCaptured.durationSeconds)} сек. Сохраняем…</p>`
        : `<p role="status">${oralRecordingActive ? 'Идёт автоматическая запись' : 'Готовим автоматическую запись'} до серверного дедлайна (${limit} сек.). Остановить или перезаписать ответ нельзя.</p>`;
  return `${visibleError ? `<p class="ege-mock__error" role="alert">${escapeHtml(visibleError)}</p>` : ''}<div class="ege-mock__layout"><aside class="ege-mock__side"><section class="ege-mock__card ege-mock__progress"><p><span>Устная часть</span><strong id="ege_mock_oral_timer">${Math.ceil(snapshot.remainingMs / 60_000)} мин</strong></p><p><span>Этап</span><strong>${stage}${stageRemaining == null ? '' : ` · ${stageRemaining} сек.`}</strong></p><p><span>Сохранение</span><strong>${snapshot.saveStatus === 'saved' ? 'на сервере' : 'в очереди'}</strong></p></section></aside><section class="ege-mock__card ege-mock__task"><header class="ege-mock__task-head"><div><p>Говорение</p><h2 tabindex="-1">Задание ${current.position} · ответ ${current.responseNumber}</h2></div><p>${stage}</p></header>${oralTaskMarkup(snapshot)}<div class="ege-mock__nav">${controls}</div></section></div>`;
}

function refreshOralProjection(snapshot) {
  renderOralHeader(snapshot);
  const timer = document.getElementById('ege_mock_oral_timer');
  if (timer) timer.textContent = `${Math.ceil(snapshot.remainingMs / 60_000)} мин`;
  const stage = document.querySelector('.ege-mock__progress p:nth-child(2) strong');
  if (stage && snapshot.current) {
    const label = snapshot.current.phase === 'ready'
      ? 'ГОТОВО' : snapshot.current.phase === 'preparing' ? 'ПОДГОТОВКА' : '● ЗАПИСЬ';
    const remaining = snapshot.current.stageDeadlineAt
      ? Math.max(0, Math.ceil(
        (new Date(snapshot.current.stageDeadlineAt).getTime() - oralAuthorityNow(snapshot)) / 1_000,
      )) : null;
    stage.textContent = `${label}${remaining == null ? '' : ` · ${remaining} сек.`}`;
  }
  const save = document.querySelector('.ege-mock__progress p:nth-child(3) strong');
  if (save) save.textContent = snapshot.saveStatus === 'saved' ? 'на сервере' : 'в очереди';
}

function oralProjectionIdentity(snapshot) {
  return [snapshot.phase, snapshot.readyToSubmit, snapshot.current?.position,
    snapshot.current?.responseNumber, snapshot.current?.phase].join(':');
}

function oralStoredProjectionIdentity(serialized) {
  if (typeof serialized !== 'string' || serialized.length > 1_000_000) return '';
  try {
    const saved = JSON.parse(serialized);
    if (!saved || saved.schemaVersion !== 'ege-mock-oral-local-v1'
      || typeof saved.phase !== 'string') return '';
    return oralProjectionIdentity(saved);
  } catch {
    return '';
  }
}

function oralRecordingLeaseIdentity(snapshot) {
  const owner = currentEgeMockOwnerBinding();
  return owner && snapshot?.attemptId
    ? `${owner.username}:${owner.generation}:${snapshot.attemptId}` : '';
}

async function ensureOralRecordingLease(snapshot, media = oralMedia) {
  if (!media || !['prepared', 'oral'].includes(snapshot?.phase)) {
    media?.releaseRecordingLease?.();
    return false;
  }
  if (media.hasRecordingLease()) return true;
  const identity = oralRecordingLeaseIdentity(snapshot);
  if (!identity) return false;
  const acquired = await media.acquireRecordingLease(identity);
  if (media !== oralMedia) {
    media.releaseRecordingLease();
    return false;
  }
  return acquired;
}

function oralRecordingBinding(recording) {
  const owner = currentEgeMockOwnerBinding();
  return {
    username: owner.username,
    ownerGeneration: owner.generation,
    attemptId: oralRunner.snapshot().attemptId,
    formId: form.id,
    formRevision: form.revision,
    catalogFingerprint: form.fingerprint,
    position: Number(recording.position),
    taskType: Number(recording.taskType),
    responseNumber: Number(recording.responseNumber),
    recordingId: recording.recordingId,
    sha256: recording.sha256,
  };
}

async function assessOralRecordings(acknowledgePossibleProviderRepeat = false) {
  if (!oralRunner || !oralMedia || oralAssessing) return;
  oralAssessing = true;
  render();
  try {
    const snapshot = oralRunner.snapshot();
    const session = await apiGet(`/api/v1/speaking/full-sessions/${snapshot.attemptId}`);
    const locale = session?.accentProfile?.locale || 'en-GB';
    const grouped = new Map();
    for (const recording of Object.values(snapshot.recordings || {})) {
      const taskType = Number(recording.taskType);
      if (!grouped.has(taskType)) grouped.set(taskType, []);
      grouped.get(taskType).push(recording);
    }
    const attemptIds = [];
    for (const task of EGE_MOCK_ORAL_TASKS) {
      const { taskType, responseCount } = task;
      const recordings = (grouped.get(taskType) || [])
        .sort((left, right) => left.responseNumber - right.responseNumber);
      if (recordings.length !== responseCount
        || recordings.some(({ status }) => status !== 'completed')) continue;
      const keys = [];
      for (const recording of recordings) {
        const blob = await oralMedia.get(oralRecordingBinding(recording));
        if (!blob) throw new Error('EGE_MOCK_ORAL_RECORDING_UNAVAILABLE');
        const headers = {
          'Idempotency-Key': recording.recordingId,
          'X-Speech-Locale': locale,
          'X-Audio-Duration-Seconds': String(recording.durationSeconds),
          'X-Speaking-Task': String(taskType),
          ...(responseCount > 1
            ? { 'X-Speaking-Item': String(recording.responseNumber) } : {}),
        };
        const uploaded = await apiPostBinary(
          `/api/v1/speaking/full-sessions/${snapshot.attemptId}/pronunciation-assessment`,
          blob, 'audio/wav', headers,
        );
        if (!uploaded?.billing?.assessmentId || uploaded.assessment?.status !== 'success') {
          throw new Error('SPEAKING_PRONUNCIATION_UNAVAILABLE');
        }
        keys.push(recording.recordingId);
      }
      const request = {
        taskType, sessionMode: 'full_section', sessionId: snapshot.attemptId,
        ...(acknowledgePossibleProviderRepeat ? { acknowledgePossibleProviderRepeat: true } : {}),
        ...(responseCount > 1
          ? { pronunciationAssessmentKeys: keys }
          : { pronunciationAssessmentKey: keys[0] }),
      };
      const evaluated = await apiPost('/api/v1/ai/evaluate-speaking', request, true);
      if (!Number.isSafeInteger(Number(evaluated?.attemptId))) {
        throw new Error('EGE_MOCK_SPEAKING_ASSESSMENT_INVALID');
      }
      attemptIds.push(Number(evaluated.attemptId));
    }
    await apiPost(
      `/api/v1/speaking/full-sessions/${snapshot.attemptId}/evaluation`, { attemptIds },
    );
    await oralRunner.dispatch({ type: 'restore', form });
    oralProviderRepeatAckRequired = false;
    visibleError = '';
  } catch (error) {
    if (error?.code === 'SPEAKING_PROVIDER_REPEAT_ACKNOWLEDGEMENT_REQUIRED') {
      oralProviderRepeatAckRequired = true;
      visibleError = 'Предыдущий вызов провайдера мог состояться. Автоматический повтор заблокирован.';
      return;
    }
    throw error;
  } finally {
    oralAssessing = false;
  }
}

async function ensureOralRunner() {
  if (oralRunner) return oralRunner;
  if (oralOpening) return oralOpening;
  if (!runner || runner.snapshot().phase !== 'written_submitted') {
    throw new Error('EGE_MOCK_ORAL_WRITTEN_STATE_REQUIRED');
  }
  const owner = currentEgeMockOwnerBinding();
  const attemptId = runner.snapshot().attemptId;
  if (!owner || !attemptId || !form) throw new Error('EGE_MOCK_ORAL_AUTHORITY_REQUIRED');
  const media = createEgeMockOralMedia();
  const candidate = createEgeMockOralRunner({
    owner, attemptId, storage: localStorage, media, online: () => navigator.onLine,
    lockManager: navigator.locks,
    attemptOwnerGeneration: runner.snapshot().attemptOwnerGeneration,
    transport: oralTransportFor(owner, attemptId),
    authority: {
      commit: (commit) => commitEgeMockOwnerMutation(
        owner, () => oralOperationCurrent(oralOperation), commit,
      ),
    },
  });
  const oralOperation = {
    epoch: openEpoch, ownerKey: ownerKey(owner), owner, attemptId,
    writtenRunner: runner, form, candidate, media,
  };
  const openingTask = (async () => {
    const restored = await candidate.dispatch({ type: 'restore', form });
    if (!oralOperationCurrent(oralOperation)) { media.dispose(); return null; }
    if (restored.phase === 'oral') {
      await media.preflight({
        form,
        tasks: EGE_MOCK_ORAL_POSITIONS.map((position) => form.positions[position - 1]),
        assets: form.assets,
      });
      if (!oralOperationCurrent(oralOperation)) { media.dispose(); return null; }
    }
    oralMedia = media;
    oralRunner = candidate;
    if (restored.phase === 'oral') {
      await ensureOralRecordingLease(restored, media);
      if (!oralOperationCurrent(oralOperation)) { media.dispose(); return null; }
      await beginAutomaticOralRecording(restored, media);
      if (!oralOperationCurrent(oralOperation)) { media.dispose(); return null; }
    }
    oralStorageKey = `easyboost-ege-mock-oral-v1:${owner.username}:${owner.generation}`;
    if (!oralTimer) oralTimer = setInterval(() => { void tickOral(); }, 1_000);
    render();
    return candidate;
  })();
  let guardedOpening;
  guardedOpening = openingTask.catch(async (error) => {
    media.dispose();
    if (!oralOperationCurrent(oralOperation)) return null;
    visibleError = apiMessage(error);
    if (oralRunner === candidate) {
      oralRunner = null;
      oralMedia = null;
    }
    render();
    return null;
  }).finally(() => {
    if (oralOpening === guardedOpening) oralOpening = null;
  });
  oralOpening = guardedOpening;
  return oralOpening;
}

async function tickOral() {
  if (!oralRunner) return;
  try {
    const before = oralRunner.snapshot();
    if (before.phase === 'oral' && !oralMedia?.hasRecordingLease?.()) {
      const acquired = await ensureOralRecordingLease(before);
      if (!acquired) {
        const observed = await oralRunner.dispatch({ type: 'refreshLocal' });
        if (oralProjectionIdentity(before) === oralProjectionIdentity(observed)) {
          refreshOralProjection(observed);
        } else render();
        return;
      }
      await beginAutomaticOralRecording(oralRunner.snapshot());
    }
    let snapshot = before;
    const expiring = before.current;
    if (before.phase === 'oral' && expiring?.stageDeadlineAt
      && oralAuthorityNow(before) >= new Date(expiring.stageDeadlineAt).getTime()) {
      if (expiring.phase === 'preparing') {
        snapshot = await oralRunner.dispatch({ type: 'advance' });
        await beginAutomaticOralRecording(snapshot);
      } else if (expiring.phase === 'recording') {
        if (oralRecordingActive) {
          try { oralCaptured = await oralMedia.stopRecording(); }
          catch { oralCaptured = null; }
          oralRecordingActive = false;
        }
        snapshot = oralCaptured
          ? await oralRunner.dispatch({
            type: 'completeResponse', blob: oralCaptured.blob,
            recording: {
              recordingId: oralCaptured.recordingId,
              durationSeconds: oralCaptured.durationSeconds,
              sha256: oralCaptured.sha256,
              status: 'completed',
            },
          })
          : await oralRunner.dispatch({
            type: 'completeResponse', blob: null,
            recording: {
              recordingId: globalThis.crypto.randomUUID(), status: 'technical_issue', durationSeconds: 0,
              technicalIssueCode: 'response_timeout',
            },
          });
        oralCaptured = null;
      }
    }
    snapshot = await oralRunner.dispatch({ type: 'tick' });
    if (snapshot.pendingCommand && navigator.onLine && Date.now() >= oralRetryAt) {
      try {
        snapshot = await oralRunner.dispatch({ type: 'sync' });
        oralRetryAt = 0;
        await beginAutomaticOralRecording(snapshot);
      } catch (error) {
        oralRetryAt = Date.now() + 2_000;
        throw error;
      }
    }
    const projectionChanged = oralProjectionIdentity(before) !== oralProjectionIdentity(snapshot);
    if (snapshot.phase !== 'oral') oralMedia?.releaseRecordingLease?.();
    if (!projectionChanged) {
      refreshOralProjection(snapshot);
    } else {
      render();
      requestAnimationFrame(() => document.querySelector('.ege-mock__task h2')?.focus?.());
    }
  } catch (error) { visibleError = apiMessage(error); render(); }
}

async function beginAutomaticOralRecording(snapshot, media = oralMedia) {
  const current = snapshot?.current;
  if (snapshot?.phase !== 'oral' || current?.phase !== 'recording'
    || !media?.hasRecordingLease?.() || oralRecordingActive || oralCaptured) return snapshot;
  const remainingSeconds = Math.ceil(
    (new Date(current.stageDeadlineAt).getTime() - oralAuthorityNow(snapshot)) / 1_000,
  );
  if (remainingSeconds <= 0) return snapshot;
  await media.startRecording(remainingSeconds);
  if (media !== oralMedia) {
    await media.cancelRecording?.();
    return snapshot;
  }
  oralRecordingActive = true;
  return snapshot;
}

async function cancelAutomaticOralRecording(media = oralMedia) {
  try { await media?.cancelRecording?.(); }
  finally {
    if (media === oralMedia) {
      oralRecordingActive = false;
      oralCaptured = null;
    }
  }
}

function render() {
  const area = document.getElementById('ege_mock_area');
  if (!area || !runner) return;
  const snapshot = runner.snapshot();
  const alert = visibleError ? `<p class="ege-mock__error" role="alert">${escapeHtml(visibleError)}</p>` : '';
  renderTimer(snapshot);
  if (['idle', 'preflighting', 'ready', 'error'].includes(snapshot.phase)) area.innerHTML = introMarkup(snapshot);
  else if (['running', 'writing'].includes(snapshot.phase)) area.innerHTML = runningMarkup(snapshot);
  else if (snapshot.phase === 'asset_blocked') area.innerHTML = `${alert}<section class="ege-mock__card ege-mock__error" role="alert"><h2>Нужны проверенные аудиофайлы</h2><p>Exact-кэш этой формы недоступен. Ответы и навигация заблокированы до подключения к сети и повторной проверки файлов; строгий письменный таймер продолжает идти.</p></section>`;
  else if (snapshot.phase === 'objective_queued') area.innerHTML = `${alert}<section class="ege-mock__card ege-mock__success"><h2>Сохраняем задания 1–36</h2><p>Checkpoint надёжно записан на этом устройстве и будет подтверждён сервером после восстановления сети. Общий письменный таймер продолжает идти.</p></section>`;
  else if (snapshot.phase === 'objective_completed') area.innerHTML = `${alert}<section class="ege-mock__card ege-mock__success"><h2>Задания 1–36 сохранены</h2><p>Сервер подтвердил checkpoint. Письменная часть ещё не сдана: общий таймер продолжает идти для заданий 37–38.</p><button class="ege-mock__action" type="button" data-ege-action="continue-writing">Перейти к заданиям 37–38</button></section>`;
  else if (snapshot.phase === 'submit_queued') area.innerHTML = `${alert}<section class="ege-mock__card ege-mock__success"><h2>Сохраняем всю письменную часть</h2><p>Ожидаем авторитетное подтверждение сервера. Локальная очередь сохранена и не создаст повторную сдачу.</p></section>`;
  else if (snapshot.phase === 'written_submitted') {
    if (oralRunner) {
      const oralSnapshot = oralRunner.snapshot();
      renderOralHeader(oralSnapshot);
      area.innerHTML = oralMarkup(oralSnapshot);
      return;
    }
    const retryWarning = snapshot.result?.writingAssessment?.retryWarning;
    const retryActions = renderEgeMockWritingAssessmentActions(
      snapshot.result?.writingAssessment,
      {
        queued: snapshot.assessmentRetryQueued || snapshot.assessmentRunQueued,
        revisionBlocked: snapshot.assessmentRunBlocked,
      },
    );
    area.innerHTML = `<section class="ege-mock__card ege-mock__success"><h2>Задания 1–38 сданы</h2>${visibleError ? `<p class="ege-mock__error" role="alert">${escapeHtml(visibleError)}</p>` : ''}${renderEgeMockWritingAssessmentStatus(snapshot.result?.writingAssessment)}${retryWarning ? `<p class="ege-mock__error" role="alert">${escapeHtml(retryWarning)}</p>` : ''}${retryActions}<p>Сервер принял ответы и пропуски. Баллы, критерии и ключи не раскрываются до завершения обеих частей пробника.</p>${snapshot.result?.offlineChangesNotAccepted ? '<p class="ege-mock__error" role="alert">После истечения времени сервер уже закрыл письменную часть. Изменения, оставшиеся только на этом устройстве, не вошли в принятую работу.</p>' : ''}<button class="ege-mock__action" type="button" data-ege-action="oral-open">Перейти к устной части</button></section>`;
  }
}

function scheduleSave() {
  if (autosave) clearTimeout(autosave);
  autosave = setTimeout(async () => {
    const operation = currentRunnerOperation();
    if (!operation) return;
    const before = operation.runner.snapshot().phase;
    try { await operation.runner.dispatch({ type: 'sync' }); } catch (error) {
      if (!runnerOperationCurrent(operation)) return;
      await handleRunnerError(error, operation);
      if (!runnerOperationCurrent(operation)) return;
      render();
      return;
    }
    if (!runnerOperationCurrent(operation)) return;
    const snapshot = operation.runner.snapshot();
    if (snapshot && snapshot.phase === before) refreshRunningProjection(snapshot);
    else if (snapshot) render();
  }, 650);
}

function refreshRunningProjection(snapshot) {
  if (oralRunner) return;
  const area = document.getElementById('ege_mock_area');
  if (!area) return;
  const writingPhase = snapshot.phase === 'writing';
  const answeredCount = writingPhase ? snapshot.writtenAnsweredCount : snapshot.answeredCount;
  const positionCount = writingPhase ? 38 : 36;
  const blankPositions = writingPhase ? snapshot.writtenBlankPositions : snapshot.blankPositions;
  const progress = area.querySelector('.ege-mock__progress progress');
  if (progress) progress.value = answeredCount;
  const count = area.querySelector('.ege-mock__progress p:first-child strong');
  if (count) count.textContent = `${answeredCount} из ${positionCount}`;
  const save = area.querySelector('#ege_mock_save strong');
  if (save) save.textContent = snapshot.saveStatus === 'saved' ? 'на сервере' : 'в очереди';
  area.querySelectorAll('.ege-mock__review [data-ege-position]').forEach((button) => {
    const position = Number(button.dataset.egePosition);
    const blank = blankPositions.includes(position);
    button.dataset.blank = String(blank);
    button.setAttribute('aria-label', `Задание ${position}${blank ? ', пропущено' : ', отвечено'}`);
  });
  const complete = area.querySelector('[data-ege-action="complete-objective"],[data-ege-action="complete-written"]');
  if (complete) complete.textContent = writingPhase
    ? `Сдать письменную часть${blankPositions.length ? ` · пропущено ${blankPositions.length}` : ''}`
    : `Завершить задания 1–36${blankPositions.length ? ` · пропущено ${blankPositions.length}` : ''}`;
  if (!['running', 'writing'].includes(snapshot.phase)) return;
  const active = document.activeElement;
  const answer = snapshot.answers[String(snapshot.currentPosition)];
  const text = area.querySelector('[data-ege-text]');
  if (text && text !== active) text.value = typeof answer === 'string' ? answer : '';
  const writing = area.querySelector('[data-ege-writing]');
  if (writing && writing !== active) writing.value = typeof answer === 'string' ? answer : '';
  const wordStatus = area.querySelector('#ege_mock_word_count');
  const item = form?.positions[snapshot.currentPosition - 1];
  if (wordStatus) wordStatus.textContent = `Слов: ${countEgeWritingWords(sanitizeEgeWritingText(answer), {
    taskType: `writing_${snapshot.currentPosition}`, assignment: item?.presentation,
  })}`;
  area.querySelectorAll('input[type=radio]').forEach((field) => {
    if (field !== active) field.checked = field.value === answer;
  });
  area.querySelectorAll('[data-ege-array-index]').forEach((field) => {
    if (field !== active) field.value = Array.isArray(answer)
      ? (answer[Number(field.dataset.egeArrayIndex)] || '') : '';
  });
}

async function handleAction(event) {
  const audioButton = event.target.closest('[data-ege-audio-play]');
  if (audioButton && !audioButton.disabled) {
    const operation = currentRunnerOperation();
    if (!operation) return;
    const group = audioButton.dataset.egeAudioPlay;
    const plays = [];
    Object.assign(plays, operation.runner.snapshot().audioPlays);
    if (!listeningModule.registerPlay(plays, group, 2)) return;
    audioButton.disabled = true;
    let token = null;
    try {
      const acquired = await operation.runner.dispatch({ type: 'audioStart', group });
      if (!runnerOperationCurrent(operation)) return;
      token = acquired.audioInFlight.token;
      const remaining = audioButton.parentElement?.querySelector('strong');
      if (remaining) remaining.textContent = String(Math.max(0, 2 - plays[group]));
      for (const audio of document.querySelectorAll('[data-ege-audio-segment]')) {
        audio.currentTime = 0;
        const ended = new Promise((resolve) => audio.addEventListener('ended', resolve, { once: true }));
        await audio.play();
        if (!runnerOperationCurrent(operation)) return;
        await ended;
        if (!runnerOperationCurrent(operation)) return;
      }
      visibleError = '';
    } catch (error) {
      if (!runnerOperationCurrent(operation)) return;
      await handleRunnerError(error, operation);
    }
    finally {
      if (token) {
        try { await operation.runner.dispatch({ type: 'audioFinish', token }); } catch (error) {
          if (runnerOperationCurrent(operation)) await handleRunnerError(error, operation);
        }
      }
    }
    if (!runnerOperationCurrent(operation)) return;
    render();
    return;
  }
  const positionButton = event.target.closest('[data-ege-position]');
  if (positionButton && !positionButton.disabled) {
    const operation = currentRunnerOperation();
    if (!operation) return;
    try {
      await operation.runner.dispatch({ type: 'navigate', position: Number(positionButton.dataset.egePosition) });
      if (!runnerOperationCurrent(operation)) return;
      visibleError = '';
    } catch (error) {
      if (!runnerOperationCurrent(operation)) return;
      await handleRunnerError(error, operation);
    }
    if (!runnerOperationCurrent(operation)) return;
    render();
    document.querySelector('.ege-mock__task h2')?.focus?.();
    return;
  }
  const button = event.target.closest('[data-ege-action]');
  if (!button) return;
  button.disabled = true;
  if (button.dataset.egeAction === 'retry-open') {
    await beginOpenRunner();
    return;
  }
  if (button.dataset.egeAction.startsWith('oral-')) {
    try {
      if (button.dataset.egeAction === 'oral-open') {
        const opened = await ensureOralRunner();
        if (!opened) return;
      }
      else if (button.dataset.egeAction === 'oral-assess') await assessOralRecordings();
      else if (button.dataset.egeAction === 'oral-assess-repeat') {
        await assessOralRecordings(true);
      }
      else {
        if (!oralRunner) await ensureOralRunner();
        if (!oralRunner) return;
        if (button.dataset.egeAction === 'oral-preflight') {
          await oralRunner.dispatch({ type: 'preflight' });
        }
        if (button.dataset.egeAction === 'oral-start') {
          if (!await ensureOralRecordingLease(oralRunner.snapshot())) {
            throw new Error('Устная часть уже активна в другой вкладке.');
          }
          await oralRunner.dispatch({ type: 'start' });
        }
        if (button.dataset.egeAction === 'oral-advance') {
          if (!await ensureOralRecordingLease(oralRunner.snapshot())) {
            throw new Error('Устная часть уже активна в другой вкладке.');
          }
          const snapshot = await oralRunner.dispatch({ type: 'advance' });
          await beginAutomaticOralRecording(snapshot);
        }
        if (button.dataset.egeAction === 'oral-submit') {
          if (!await ensureOralRecordingLease(oralRunner.snapshot())) {
            throw new Error('Устная часть уже активна в другой вкладке.');
          }
          await oralRunner.dispatch({ type: 'submit' });
          oralMedia?.releaseRecordingLease?.();
        }
      }
      visibleError = '';
    } catch (error) { visibleError = apiMessage(error); }
    render();
    return;
  }
  const operation = currentRunnerOperation();
  if (!operation) return;
  try {
    if (button.dataset.egeAction === 'prepare') await operation.runner.dispatch({ type: 'prepare', form: operation.form });
    if (button.dataset.egeAction === 'start') await operation.runner.dispatch({ type: 'start' });
    if (button.dataset.egeAction === 'complete-objective') {
      const omissions = operation.runner.snapshot().blankPositions.length;
      if (!confirm(`Завершить задания 1–36?${omissions ? ` Пропущено: ${omissions}.` : ''} Письменный таймер продолжит идти для заданий 37–38.`)) return;
      await operation.runner.dispatch({ type: 'completeObjective' });
    }
    if (button.dataset.egeAction === 'continue-writing') {
      await operation.runner.dispatch({ type: 'continueWriting' });
    }
    if (button.dataset.egeAction === 'complete-written') {
      const omissions = operation.runner.snapshot().writtenBlankPositions.length;
      if (!confirm(`Сдать всю письменную часть?${omissions ? ` Пропущено: ${omissions}.` : ''} После сдачи изменить ответы нельзя.`)) return;
      await operation.runner.dispatch({ type: 'completeWritten' });
    }
    if (button.dataset.egeAction === 'retry-assessment') {
      await operation.runner.dispatch({ type: 'retryAssessment' });
    }
    if (button.dataset.egeAction === 'run-assessment-after-renewal') {
      await operation.runner.dispatch({ type: 'runAssessmentAfterRenewal' });
    }
    if (button.dataset.egeAction === 'retry-assessment-ambiguous') {
      const warning = operation.runner.snapshot().result?.writingAssessment?.retryWarning
        || 'Предыдущую работу провайдера нельзя подтвердить. Повтор может создать ещё один вызов.';
      if (!confirm(`${warning} Продолжить?`)) return;
      await operation.runner.dispatch({
        type: 'retryAssessment', acknowledgePossibleProviderRepeat: true,
      });
    }
    if (!runnerOperationCurrent(operation)) return;
    visibleError = '';
  } catch (error) {
    if (!runnerOperationCurrent(operation)) return;
    await handleRunnerError(error, operation);
  } finally {
    if (runnerOperationCurrent(operation)) render();
  }
}

async function handleAnswer(event) {
  const operation = currentRunnerOperation();
  if (!operation) return;
  const item = operation.form?.positions[operation.runner.snapshot().currentPosition - 1];
  if (!item) return;
  let answer;
  if (event.target.matches('[data-ege-text],[data-ege-writing]')) answer = event.target.value;
  else if (event.target.matches('input[type=radio]')) answer = event.target.value;
  else if (event.target.matches('[data-ege-array-index]')) {
    const before = operation.runner.snapshot().answers[String(item.position)];
    const presentation = item.presentation;
    const count = presentation.kind === 'listening_matching' ? item.assetIds.length
      : presentation.kind === 'listening_true_false' ? presentation.statements.length
        : presentation.kind === 'reading_headings' ? presentation.texts.length
          : presentation.segments.length - 1;
    answer = Array.from({ length: count }, (_, index) => Array.isArray(before) ? (before[index] || '') : '');
    const index = Number(event.target.dataset.egeArrayIndex);
    const value = event.target.value || '';
    if (presentation.kind === 'listening_matching') answer = normalizeEgeMockSelection(
      listeningModule.selectUnique(answer, index, value),
    );
    else if (['reading_headings', 'reading_gaps'].includes(presentation.kind)) answer = normalizeEgeMockSelection(
      readingModule.selectUnique(answer, index, value),
    );
    else answer[index] = value;
  } else return;
  try {
    await operation.runner.dispatch({ type: 'answer', position: item.position, answer });
    if (!runnerOperationCurrent(operation)) return;
    visibleError = '';
  } catch (error) {
    if (!runnerOperationCurrent(operation)) return;
    await handleRunnerError(error, operation);
    if (!runnerOperationCurrent(operation)) return;
    render();
    return;
  }
  if (Array.isArray(answer)) document.querySelectorAll('[data-ege-array-index]').forEach((field) => {
    field.value = answer[Number(field.dataset.egeArrayIndex)] || '';
  });
  scheduleSave();
  if (!runnerOperationCurrent(operation)) return;
  const snapshot = operation.runner.snapshot();
  refreshRunningProjection(snapshot);
}

function startClock() {
  if (timer) return;
  timer = setInterval(async () => {
    const operation = currentRunnerOperation();
    if (!operation) return;
    const phase = operation.runner.snapshot().phase;
    try { await operation.runner.dispatch({ type: 'tick' }); } catch (error) {
      if (!runnerOperationCurrent(operation)) return;
      await handleRunnerError(error, operation);
      if (!runnerOperationCurrent(operation)) return;
      retryAt = Date.now() + 1000;
      render();
      return;
    }
    if (!runnerOperationCurrent(operation)) return;
    const afterTick = operation.runner.snapshot();
    const retryQueued = afterTick.saveStatus === 'queued'
      && (afterTick.phase !== 'submit_queued' || phase === 'submit_queued');
    if (navigator.onLine && retryQueued && Date.now() >= retryAt) {
      try { await operation.runner.dispatch({ type: 'sync' }); } catch (error) {
        if (!runnerOperationCurrent(operation)) return;
        await handleRunnerError(error, operation);
        if (!runnerOperationCurrent(operation)) return;
        retryAt = Date.now() + 2000;
        render();
        return;
      }
      retryAt = 0;
    }
    if (!runnerOperationCurrent(operation)) return;
    const snapshot = operation.runner.snapshot();
    renderTimer(snapshot);
    if (phase === snapshot.phase) refreshRunningProjection(snapshot);
    else render();
  }, 1000);
}

async function openRunner(operation) {
  const owner = operation.owner;
  const area = document.getElementById('ege_mock_area');
  if (!owner || !area || !openOperationCurrent(operation)) return;
  document.getElementById('frame')?.classList.add('ege-mock-expanded');
  resetRunnerState(true, false);
  if (!openOperationCurrent(operation)) return;
  document.getElementById('frame')?.classList.add('ege-mock-expanded');
  const storageKey = `easyboost-ege-mock-written-v1:${owner.username}:${owner.generation}`;
  const invalidationKey = egeMockWrittenInvalidationKey(owner);
  const localForm = await loadEgeMockPublicForm();
  if (!openOperationCurrent(operation)) return;
  let committed = false;
  let localRunner = null;
  const authorityCurrent = () => {
    const bindingKey = ownerKey(currentEgeMockOwnerBinding());
    const active = document.getElementById('scr16')?.classList.contains('on');
    const current = committed
      ? runner === localRunner && runnerOwnerKey === operation.ownerKey
        && operation.ownerKey === bindingKey && active
      : operation.epoch === openEpoch && operation.ownerKey === bindingKey && active;
    return current;
  };
  localRunner = createEgeMockWrittenRunner({
    owner, storage: localStorage, online: () => navigator.onLine,
    assets: createEgeMockAssetPreflight(), transport: transportFor(owner),
    authority: {
      commit: (commit) => commitEgeMockOwnerMutation(
        owner, authorityCurrent, commit,
      ),
    },
  });
  try { await localRunner.dispatch({ type: 'restore', form: localForm }); } catch (error) {
    if (!openOperationCurrent(operation)) return;
    const failedOperation = { ...operation, runner: localRunner, form: localForm, storageKey };
    if (await handleRunnerError(error, failedOperation)) return;
    if (!openOperationCurrent(operation)) return;
    renderUnavailableAttempt();
    return;
  }
  if (!openOperationCurrent(operation)) return;
  runner = localRunner;
  runnerOwnerKey = operation.ownerKey;
  runnerStorageKey = storageKey;
  runnerInvalidationKey = invalidationKey;
  form = localForm;
  committed = true;
  if (runner.snapshot().phase === 'written_submitted'
    && hasLocalOralState(owner)) {
    await ensureOralRunner();
  } else render();
  startClock();
}

async function handleOpenFailure(error, operation) {
  if (!openOperationCurrent(operation) || await handleRunnerError(error, operation)) return;
  if (!openOperationCurrent(operation)) return;
  stopTimers();
  runner = null;
  runnerOwnerKey = '';
  runnerStorageKey = '';
  runnerInvalidationKey = '';
  form = null;
  if (!openOperationCurrent(operation)) return;
  document.getElementById('frame')?.classList.add('ege-mock-expanded');
  const area = document.getElementById('ege_mock_area');
  if (area) area.innerHTML = `<p class="ege-mock__error" role="alert">${escapeHtml(visibleError)}</p><section class="ege-mock__card ege-mock__intro"><h2>Вариант не загрузился</h2><p>Точный файл формы сейчас недоступен. Таймер не запущен, ответы не изменены.</p><button class="ege-mock__action" type="button" data-ege-action="retry-open">Повторить загрузку</button></section>`;
}

function beginOpenRunner() {
  const owner = currentEgeMockOwnerBinding();
  const nextOwnerKey = ownerKey(owner);
  if (!owner || !nextOwnerKey) return Promise.resolve();
  if (opening && openingOwnerKey === nextOwnerKey) return opening;
  const operation = { epoch: ++openEpoch, owner, ownerKey: nextOwnerKey };
  const task = openRunner(operation).catch((error) => handleOpenFailure(error, operation)).finally(() => {
    if (opening === task) {
      opening = null;
      openingOwnerKey = '';
    }
  });
  opening = task;
  openingOwnerKey = nextOwnerKey;
  return task;
}

const area = document.getElementById('ege_mock_area');
area?.addEventListener('click', (event) => { handleAction(event); });
area?.addEventListener('input', (event) => { handleAnswer(event); });
window.addEventListener('online', () => {
  if (oralRunner) {
    const candidateRunner = oralRunner;
    const candidateMedia = oralMedia;
    void (async () => {
      const before = candidateRunner.snapshot();
      const ownsCapture = candidateMedia?.hasRecordingLease?.()
        || await ensureOralRecordingLease(before, candidateMedia);
      if (oralRunner !== candidateRunner || oralMedia !== candidateMedia) return;
      const snapshot = await candidateRunner.dispatch({
        type: ownsCapture ? 'sync' : 'refreshLocal',
      });
      if (oralRunner !== candidateRunner || oralMedia !== candidateMedia) return;
      await beginAutomaticOralRecording(snapshot, candidateMedia);
      render();
    })().catch((error) => { visibleError = apiMessage(error); render(); });
  }
  const operation = currentRunnerOperation();
  if (!operation) return;
  const before = operation.runner.snapshot();
  operation.runner.dispatch({ type: before.phase === 'asset_blocked' ? 'restore' : 'sync', form: operation.form })
    .then((snapshot) => {
      if (!runnerOperationCurrent(operation)) return;
      visibleError = '';
      if (snapshot.phase === before.phase && snapshot.currentPosition === before.currentPosition) {
        renderTimer(snapshot);
        refreshRunningProjection(snapshot);
      } else render();
    })
    .catch(async (error) => {
      if (!runnerOperationCurrent(operation)) return;
      await handleRunnerError(error, operation);
      if (runnerOperationCurrent(operation)) render();
    });
});
window.addEventListener('storage', (event) => {
  if (oralRunner && event.key === oralStorageKey) {
    const candidateRunner = oralRunner;
    const candidateMedia = oralMedia;
    void (async () => {
      const beforeIdentity = oralProjectionIdentity(candidateRunner.snapshot());
      const incomingIdentity = oralStoredProjectionIdentity(event.newValue);
      const captureNeedsRebinding = incomingIdentity !== '' && incomingIdentity !== beforeIdentity;
      if (captureNeedsRebinding) await cancelAutomaticOralRecording();
      if (oralRunner !== candidateRunner || oralMedia !== candidateMedia) return;
      const snapshot = await candidateRunner.dispatch({ type: 'refreshLocal' });
      if (oralRunner !== candidateRunner || oralMedia !== candidateMedia) return;
      const projectionChanged = oralProjectionIdentity(snapshot) !== beforeIdentity;
      if (projectionChanged && !captureNeedsRebinding) await cancelAutomaticOralRecording();
      if (oralRunner !== candidateRunner || oralMedia !== candidateMedia) return;
      await ensureOralRecordingLease(snapshot, candidateMedia);
      await beginAutomaticOralRecording(snapshot, candidateMedia);
      render();
    })().catch((error) => { visibleError = apiMessage(error); render(); });
  }
  if (runner && (event.key === runnerStorageKey || event.key === runnerInvalidationKey)) {
    const operation = currentRunnerOperation();
    if (!operation) return;
    const before = operation.runner.snapshot();
    operation.runner.dispatch({ type: 'refreshLocal' }).then((snapshot) => {
      if (!runnerOperationCurrent(operation)) return;
      if (snapshot.phase === before.phase && snapshot.currentPosition === before.currentPosition) {
        renderTimer(snapshot);
        refreshRunningProjection(snapshot);
      } else render();
    }).catch(async (error) => {
      if (!runnerOperationCurrent(operation)) return;
      await handleRunnerError(error, operation);
    });
  }
});
registerRouteHook((id) => {
  if (id === 'scr16') {
    beginOpenRunner();
  } else {
    openEpoch += 1;
    opening = null;
    openingOwnerKey = '';
    stopTimers();
    oralMedia?.dispose?.();
    oralRecordingActive = false;
    document.getElementById('frame')?.classList.remove('ege-mock-expanded');
  }
});
registerAuthorityReset(resetRunner);

export { openRunner };
