/*
 * Режим работы и точки подключения к профилю раньше искались в глобальной области.
 * В модуле их не видно, а `typeof SRV === 'undefined'` тихо отключил бы согласия целиком,
 * поэтому зависимости приходят импортом и остаются живыми при смене серверной сессии.
 */
import {SRV,currentUser,invalidateLearningAuthority,registerAuthorityReset} from './app.js';

(function initializePrivacyControls(global) {
  'use strict';
  const api = global.EasyBoostApi;
  let current = null;
  let calibrationConsent = null;
  let privacyReturnFocus = null;
  let privacyBackgroundState = [];
  let privacyOperation = 0;
  let privacyPending = false;

  function privacyAuthority() {
    const owner = currentUser;
    const ownerGeneration = global.EasyBoostSync?.ownerBoundGeneration?.(owner);
    return owner && Number.isSafeInteger(ownerGeneration) ? { owner, ownerGeneration } : null;
  }

  function privacyAuthorityCurrent(authority) {
    return Boolean(authority && currentUser === authority.owner
      && global.EasyBoostSync?.ownerBoundGeneration?.(authority.owner) === authority.ownerGeneration);
  }

  function privacyHeaders(authority) {
    return { 'X-EasyBoost-Expected-Owner': authority.owner };
  }

  function privacyResponseOwned(payload, authority) {
    return privacyAuthorityCurrent(authority) && api.responseOwner(payload) === authority.owner;
  }

  async function rejectPrivacyAuthority(authority) {
    if (privacyAuthorityCurrent(authority)) await invalidateLearningAuthority(authority);
    return null;
  }

  function privacyControls(sheet) {
    return [...sheet.querySelectorAll('button:not(:disabled),input:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])')]
      .filter((control) => !control.hidden && control.offsetParent !== null);
  }

  function privacyOperationCurrent(operation, authority) {
    return operation === privacyOperation && privacyAuthorityCurrent(authority);
  }

  function setPrivacyPending(pending, message = '', focusOnSettle = null) {
    const sheet = document.getElementById('privacySheet');
    const status = document.getElementById('privacyStatus');
    privacyPending = Boolean(pending);
    if (!sheet || !status) return;
    sheet.querySelectorAll('button,input').forEach((control) => { control.disabled = privacyPending; });
    if (privacyPending) {
      sheet.setAttribute('aria-busy', 'true');
      if (message) status.textContent = message;
      status.tabIndex = 0;
      status.focus({ preventScroll: true });
      return;
    }
    sheet.removeAttribute('aria-busy');
    status.removeAttribute('tabindex');
    if (message) status.textContent = message;
    if (sheet.classList.contains('open')) {
      const target = focusOnSettle && !focusOnSettle.hidden && !focusOnSettle.disabled
        ? focusOnSettle : document.getElementById('privacyClose');
      target?.focus({ preventScroll: true });
    }
  }

  function isolatePrivacyBackground(sheet) {
    if (privacyBackgroundState.length) return;
    privacyBackgroundState = [...document.body.children]
      .filter((element) => element !== sheet)
      .map((element) => ({
        element,
        hadInert: element.hasAttribute('inert'),
        hadAriaHidden: element.hasAttribute('aria-hidden'),
        ariaHidden: element.getAttribute('aria-hidden'),
      }));
    for (const { element } of privacyBackgroundState) {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    }
  }

  function restorePrivacyBackground() {
    for (const { element, hadInert, hadAriaHidden, ariaHidden } of privacyBackgroundState) {
      if (!element.isConnected) continue;
      if (hadInert) element.setAttribute('inert', '');
      else element.removeAttribute('inert');
      if (hadAriaHidden) element.setAttribute('aria-hidden', ariaHidden);
      else element.removeAttribute('aria-hidden');
    }
    privacyBackgroundState = [];
  }

  function ensureSheet() {
    if (document.getElementById('privacySheet')) return;
    const sheet = document.createElement('div');
    sheet.id = 'privacySheet';
    sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-labelledby', 'privacyTitle');
    sheet.setAttribute('aria-hidden', 'true');
    sheet.innerHTML = `<div class="privacyBackdrop"></div><section class="privacyPanel"><h2 id="privacyTitle">Приватность и ИИ</h2>
      <p>Обычные задания работают без передачи данных ИИ. Для дополнительных функций выберите, что разрешаете отправлять внешним провайдерам.</p>
      <ul><li>Текст ответа — для проверки через настроенного провайдера xAI или Groq.</li><li>Имя «Ася» действует только в явно открытой микрофонной сессии Aisy.space; приложение не слушает устройство в фоне.</li><li>Во время голосового разбора с Асей голос передаётся внешнему AI-провайдеру потоком в реальном времени.</li><li>Aisy.space не сохраняет исходное аудио, полную расшифровку или свободные голосовые реплики; сохраняется только структурированный учебный результат.</li><li>ИИ-оценка ориентировочная и не является официальной.</li></ul>
      <label class="privacyChoice"><input id="privacyText" type="checkbox"><span><b>Обработка текста</b><span>Разрешить отправку текста учебного ответа AI-провайдеру.</span></span></label>
      <label class="privacyChoice"><input id="privacyVoice" type="checkbox"><span><b>Потоковая обработка голоса</b><span>Разрешить двустороннюю realtime speech-to-speech передачу внешнему AI-провайдеру. Аудио и полный transcript не сохраняются; согласие можно отозвать здесь до следующего разговора.</span></span></label>
      <div id="privacyCalibration" class="privacyCalibration"><b>Добровольная экспертная калибровка произношения</b><span id="privacyCalibrationState">Проверяем отдельное согласие…</span><button id="privacyCalibrationRevoke" class="privacyBtn privacyDangerAction" type="button" hidden>Отозвать согласие и удалить незавершённые аудиозаписи</button></div>
      <a class="privacyLink" href="/privacy.html" target="_blank" rel="noopener">Открыть политику конфиденциальности</a>
      <div id="privacyStatus" class="privacyStatus" role="status" aria-live="polite"></div>
      <div class="privacyActions"><button id="privacyClose" class="privacyBtn privacySecondary" type="button">Позже</button><button id="privacySave" class="aisy-button privacyPrimary" type="button">Сохранить выбор</button></div></section>`;
    document.body.appendChild(sheet);
    sheet.querySelector('.privacyBackdrop').onclick = () => closePrivacy();
    document.getElementById('privacyClose').onclick = () => closePrivacy();
    document.getElementById('privacySave').onclick = savePrivacy;
    document.getElementById('privacyCalibrationRevoke').onclick = revokeCalibrationConsent;
    sheet.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); if (!privacyPending) closePrivacy(); return; }
      if (event.key !== 'Tab') return;
      const controls = privacyControls(sheet);
      if (!controls.length) { event.preventDefault(); return; }
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
  }

  function renderPrivacy(invoker = null) {
    ensureSheet();
    const sheet = document.getElementById('privacySheet');
    if (!sheet.classList.contains('open')) {
      privacyReturnFocus = invoker && invoker !== document.body && !sheet.contains(invoker) ? invoker : null;
    }
    document.getElementById('privacyText').checked = Boolean(current?.text_processing);
    document.getElementById('privacyVoice').checked = Boolean(current?.voice_processing);
    document.getElementById('privacyStatus').textContent = '';
    setPrivacyPending(false);
    updateCalibrationPrivacy();
    isolatePrivacyBackground(sheet);
    sheet.removeAttribute('aria-hidden');
    sheet.classList.add('open');
    document.getElementById('privacyText').focus();
  }
  async function openPrivacy() {
    const invoker = document.activeElement;
    const authority = privacyAuthority();
    if (!authority) return;
    await Promise.all([loadPrivacy(false, authority), loadCalibrationConsent(authority)]);
    if (!privacyAuthorityCurrent(authority)) return;
    renderPrivacy(invoker);
  }
  function updateCalibrationPrivacy() {
    const state = document.getElementById('privacyCalibrationState');
    const revoke = document.getElementById('privacyCalibrationRevoke');
    if (!state || !revoke) return;
    const granted = Boolean(calibrationConsent?.granted);
    state.textContent = granted
      ? 'Согласие действует. Его можно отозвать даже после окончания доступа.'
      : 'Согласие не действует; аудиозаписи для экспертного корпуса не принимаются.';
    revoke.hidden = !granted;
  }
  async function loadCalibrationConsent(authority = privacyAuthority()) {
    if (!SRV || !authority) return null;
    try {
      const payload = await api.get('/api/v1/speaking/calibration-consent', { headers: privacyHeaders(authority) });
      if (!privacyResponseOwned(payload, authority)) return rejectPrivacyAuthority(authority);
      calibrationConsent = payload?.consent || null;
      updateCalibrationPrivacy();
      return calibrationConsent;
    } catch (error) {
      if (api.isAuthorityFailure(error)) return rejectPrivacyAuthority(authority);
      return null;
    }
  }
  async function revokeCalibrationConsent() {
    const button = document.getElementById('privacyCalibrationRevoke');
    const status = document.getElementById('privacyStatus');
    if (!calibrationConsent?.granted || !button || !status) return;
    const authority = privacyAuthority();
    if (!authority) return;
    const operation = ++privacyOperation;
    setPrivacyPending(true, 'Отзываем согласие и удаляем незавершённые аудиозаписи…');
    try {
      const nextConsent = await api.put('/api/v1/speaking/calibration-consent', {
        granted: false,
        ageGroup: calibrationConsent.age_group,
        guardianConfirmed: Boolean(calibrationConsent.guardian_confirmed),
      }, privacyHeaders(authority));
      if (!privacyOperationCurrent(operation, authority)) return;
      if (!privacyResponseOwned(nextConsent, authority)) return rejectPrivacyAuthority(authority);
      calibrationConsent = nextConsent;
      status.textContent = 'Согласие отозвано; незавершённые аудиозаписи удалены.';
      updateCalibrationPrivacy();
    } catch (error) {
      if (!privacyOperationCurrent(operation, authority)) return;
      if (api.isAuthorityFailure(error)) return rejectPrivacyAuthority(authority);
      status.textContent = api.messageFor(error);
    }
    finally {
      if (privacyOperationCurrent(operation, authority)) {
        setPrivacyPending(false, '', button.hidden ? document.getElementById('privacyClose') : button);
      }
    }
  }
  async function openCalibrationPrivacy() {
    await openPrivacy();
    const revoke = document.getElementById('privacyCalibrationRevoke');
    if (revoke && !revoke.hidden) revoke.focus();
  }
  function closePrivacy(force = false) {
    const sheet = document.getElementById('privacySheet');
    if (privacyPending && !force) return false;
    if (!sheet?.classList.contains('open')) return;
    sheet.classList.remove('open');
    sheet.setAttribute('aria-hidden', 'true');
    restorePrivacyBackground();
    const target = privacyReturnFocus;
    privacyReturnFocus = null;
    if (target?.isConnected) queueMicrotask(() => target.focus());
    return true;
  }
  async function savePrivacy() {
    const button = document.getElementById('privacySave'); const status = document.getElementById('privacyStatus');
    const authority = privacyAuthority();
    if (!authority) return;
    const operation = ++privacyOperation;
    setPrivacyPending(true, 'Сохраняем…');
    try {
      const next = await api.put('/api/v1/privacy/consent', { text_processing: document.getElementById('privacyText').checked, voice_processing: document.getElementById('privacyVoice').checked }, privacyHeaders(authority));
      if (!privacyOperationCurrent(operation, authority)) return;
      if (!privacyResponseOwned(next, authority)) return rejectPrivacyAuthority(authority);
      current = next;
      status.textContent = 'Выбор сохранён.';
      setTimeout(function(){if(privacyOperationCurrent(operation, authority))closePrivacy()}, 500);
      updateProfile();
    } catch (error) {
      if (!privacyOperationCurrent(operation, authority)) return;
      if (api.isAuthorityFailure(error)) return rejectPrivacyAuthority(authority);
      status.textContent = api.messageFor(error);
    }
    finally {
      if (privacyOperationCurrent(operation, authority)) {
        setPrivacyPending(false, '', document.getElementById('privacyClose'));
      }
    }
  }
  function updateProfile() {
    const label = document.getElementById('pf_ai');
    if (label) {
      label.textContent = current?.text_processing ? 'Разрешено' : 'Выключено';
      label.dataset.state = current?.text_processing ? 'active' : 'inactive';
    }
  }
  async function loadPrivacy(showIfNew, authority = privacyAuthority()) {
    if (!SRV || !authority) return null;
    try {
      const next = await api.get('/api/v1/privacy/consent', { headers: privacyHeaders(authority) });
      if (!privacyResponseOwned(next, authority)) return rejectPrivacyAuthority(authority);
      current = next;
      updateProfile();
      if (showIfNew && current.policy_version !== current.current_policy_version) renderPrivacy();
      return current;
    } catch (error) {
      if (api.isAuthorityFailure(error)) return rejectPrivacyAuthority(authority);
      return null;
    }
  }
  function addProfileControls() {
    const privacyHost = document.getElementById('profile_privacy_actions');
    const button = document.getElementById('privacyProfileButton');
    if (!privacyHost || !button) return;
    if (!button.dataset.bound) {
      button.dataset.bound = 'true';
      button.addEventListener('click', openPrivacy);
    }
    loadPrivacy(false);
  }
  global.EasyBoostPrivacy = Object.freeze({
    addProfileControls, loadCalibrationConsent, loadPrivacy, openCalibrationPrivacy, openPrivacy,
  });

  registerAuthorityReset(function(){
    privacyOperation += 1;
    privacyPending = false;
    current = null;
    calibrationConsent = null;
    privacyReturnFocus = null;
    setPrivacyPending(false);
    closePrivacy(true);
    updateProfile();
  });
})(window);

const controls=window.EasyBoostPrivacy;
export const addProfileControls=controls.addProfileControls;
export const loadCalibrationConsent=controls.loadCalibrationConsent;
export const loadPrivacy=controls.loadPrivacy;
export const openCalibrationPrivacy=controls.openCalibrationPrivacy;
export const openPrivacy=controls.openPrivacy;
