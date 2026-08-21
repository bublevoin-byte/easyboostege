/*
 * Режим работы и точки подключения к профилю раньше искались в глобальной области.
 * В модуле их не видно, а `typeof SRV === 'undefined'` тихо отключил бы согласия целиком,
 * поэтому зависимости приходят импортом и остаются живыми при смене серверной сессии.
 */
import {SRV, registerProfileHook, registerStartHook} from './app.js';

(function initializePrivacyControls(global) {
  'use strict';
  const api = global.EasyBoostApi;
  let current = null;
  let calibrationConsent = null;

  function ensureSheet() {
    if (document.getElementById('privacySheet')) return;
    const style = document.createElement('style');
    style.textContent = `
      #privacySheet{position:fixed;inset:0;z-index:100001;display:none}#privacySheet.open{display:block}
      #privacySheet .privacyBackdrop{position:absolute;inset:0;background:var(--aisy-color-scrim)}
      #privacySheet .privacyPanel{position:absolute;left:50%;bottom:0;transform:translateX(-50%);width:min(100%,430px);max-height:92dvh;overflow:auto;background:var(--aisy-color-surface);border-radius:26px 26px 0 0;padding:20px 20px calc(24px + env(safe-area-inset-bottom));box-shadow:var(--aisy-shadow-2);color:var(--aisy-color-text)}
      #privacySheet h2{margin:0;color:var(--aisy-color-text);font:800 21px var(--aisy-font-friendly)}#privacySheet p,#privacySheet li{color:var(--aisy-color-text-muted);font:600 16px/1.55 var(--aisy-font-interface)}
      .privacyChoice{display:grid;grid-template-columns:24px 1fr;gap:12px;align-items:start;padding:14px;margin:10px 0;border:1.5px solid var(--aisy-color-border);border-radius:16px;cursor:pointer}.privacyChoice input{width:22px;height:22px;min-height:0;accent-color:var(--aisy-color-primary);margin:1px 0}.privacyChoice b{display:block;color:var(--aisy-color-text);font-size:16px}.privacyChoice span{display:block;color:var(--aisy-color-text-muted);font-size:16px;line-height:1.5;margin-top:3px}
      .privacyActions{display:flex;gap:10px;margin-top:16px}.privacyBtn{min-height:48px;border-radius:15px;border:0;padding:0 16px;font:800 16px var(--aisy-font-interface);cursor:pointer}.privacyBtn:disabled{opacity:.48;cursor:not-allowed}.privacyPrimary{flex:1;background:var(--aisy-color-primary);color:var(--aisy-color-on-primary)}.privacySecondary{background:var(--aisy-color-surface-muted);color:var(--aisy-color-text)}
      .privacyLink{color:var(--aisy-color-primary);font-weight:800}.privacyStatus{min-height:20px;color:var(--aisy-color-danger);font:700 16px/1.4 var(--aisy-font-interface);margin-top:8px}
      .privacyProfileBtn{width:100%;min-height:48px;border:0;border-top:1px solid var(--aisy-color-border);background:var(--aisy-color-surface);padding:12px 16px;text-align:left;font:700 16px var(--aisy-font-interface);color:var(--aisy-color-text);cursor:pointer}
      .privacyCalibration{margin:14px 0;padding:14px;border:1.5px solid var(--aisy-color-border);border-radius:16px;background:var(--aisy-color-surface-muted);color:var(--aisy-color-text-muted);font:600 16px/1.5 var(--aisy-font-interface)}.privacyCalibration b{display:block;color:var(--aisy-color-text);font-size:16px;margin-bottom:4px}.privacyCalibration button{width:100%;min-height:44px;margin-top:10px;border:1.5px solid var(--aisy-color-danger);border-radius:13px;background:var(--aisy-color-surface);color:var(--aisy-color-danger);font:800 16px var(--aisy-font-interface);cursor:pointer}
    `;
    document.head.appendChild(style);
    const sheet = document.createElement('div');
    sheet.id = 'privacySheet';
    sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-labelledby', 'privacyTitle');
    sheet.innerHTML = `<div class="privacyBackdrop"></div><section class="privacyPanel"><h2 id="privacyTitle">Приватность и ИИ</h2>
      <p>Обычные задания работают без передачи данных ИИ. Для дополнительных функций выберите, что разрешаете отправлять внешним провайдерам.</p>
      <ul><li>Текст ответа — для проверки через настроенного провайдера xAI или Groq.</li><li>Имя «Ася» действует только в явно открытой микрофонной сессии Aisy.space; приложение не слушает устройство в фоне.</li><li>Во время разговора с Асей (Voice Error Tutor) голос передаётся внешнему AI-провайдеру потоком в реальном времени.</li><li>Aisy.space не сохраняет исходное аудио, полный transcript или свободные голосовые реплики; сохраняется только структурированный учебный результат.</li><li>ИИ-оценка ориентировочная и не является официальной.</li></ul>
      <label class="privacyChoice"><input id="privacyText" type="checkbox"><span><b>Обработка текста</b><span>Разрешить отправку текста учебного ответа AI-провайдеру.</span></span></label>
      <label class="privacyChoice"><input id="privacyVoice" type="checkbox"><span><b>Потоковая обработка голоса</b><span>Разрешить двустороннюю realtime speech-to-speech передачу внешнему AI-провайдеру. Аудио и полный transcript не сохраняются; согласие можно отозвать здесь до следующего разговора.</span></span></label>
      <div id="privacyCalibration" class="privacyCalibration"><b>Добровольная экспертная калибровка произношения</b><span id="privacyCalibrationState">Проверяем отдельное согласие…</span><button id="privacyCalibrationRevoke" type="button" hidden>Отозвать согласие и удалить незавершённые аудиозаписи</button></div>
      <a class="privacyLink" href="/privacy.html" target="_blank" rel="noopener">Открыть политику конфиденциальности</a>
      <div id="privacyStatus" class="privacyStatus" role="status" aria-live="polite"></div>
      <div class="privacyActions"><button id="privacyClose" class="privacyBtn privacySecondary" type="button">Позже</button><button id="privacySave" class="privacyBtn privacyPrimary" type="button">Сохранить выбор</button></div></section>`;
    document.body.appendChild(sheet);
    sheet.querySelector('.privacyBackdrop').onclick = closePrivacy;
    document.getElementById('privacyClose').onclick = closePrivacy;
    document.getElementById('privacySave').onclick = savePrivacy;
    document.getElementById('privacyCalibrationRevoke').onclick = revokeCalibrationConsent;
    sheet.addEventListener('keydown', (event) => { if (event.key === 'Escape') closePrivacy(); });
  }

  function openPrivacy() {
    ensureSheet();
    document.getElementById('privacyText').checked = Boolean(current?.text_processing);
    document.getElementById('privacyVoice').checked = Boolean(current?.voice_processing);
    document.getElementById('privacyStatus').textContent = '';
    updateCalibrationPrivacy();
    document.getElementById('privacySheet').classList.add('open');
    document.getElementById('privacyText').focus();
  }
  function updateCalibrationPrivacy() {
    const state = document.getElementById('privacyCalibrationState');
    const revoke = document.getElementById('privacyCalibrationRevoke');
    if (!state || !revoke) return;
    const granted = Boolean(calibrationConsent?.granted);
    state.textContent = granted
      ? 'Согласие действует. Его можно отозвать даже после окончания подписки.'
      : 'Согласие не действует; аудиозаписи для экспертного корпуса не принимаются.';
    revoke.hidden = !granted;
  }
  async function loadCalibrationConsent() {
    if (!SRV) return null;
    try {
      const payload = await api.get('/api/v1/speaking/calibration-consent');
      calibrationConsent = payload?.consent || null;
      updateCalibrationPrivacy();
      return calibrationConsent;
    } catch (_) { return null; }
  }
  async function revokeCalibrationConsent() {
    const button = document.getElementById('privacyCalibrationRevoke');
    const status = document.getElementById('privacyStatus');
    if (!calibrationConsent?.granted || !button || !status) return;
    button.disabled = true; status.textContent = 'Отзываем согласие и удаляем незавершённые аудиозаписи…';
    try {
      calibrationConsent = await api.put('/api/v1/speaking/calibration-consent', {
        granted: false,
        ageGroup: calibrationConsent.age_group,
        guardianConfirmed: Boolean(calibrationConsent.guardian_confirmed),
      });
      status.textContent = 'Согласие отозвано; незавершённые аудиозаписи удалены.';
      updateCalibrationPrivacy();
    } catch (error) { status.textContent = api.messageFor(error); }
    finally { button.disabled = false; }
  }
  async function openCalibrationPrivacy() {
    ensureSheet();
    await Promise.all([loadPrivacy(false), loadCalibrationConsent()]);
    openPrivacy();
    const revoke = document.getElementById('privacyCalibrationRevoke');
    if (revoke && !revoke.hidden) revoke.focus();
  }
  function closePrivacy() { document.getElementById('privacySheet')?.classList.remove('open'); }
  async function savePrivacy() {
    const button = document.getElementById('privacySave'); const status = document.getElementById('privacyStatus');
    button.disabled = true; status.textContent = 'Сохраняем…';
    try {
      current = await api.put('/api/v1/privacy/consent', { text_processing: document.getElementById('privacyText').checked, voice_processing: document.getElementById('privacyVoice').checked });
      status.textContent = 'Выбор сохранён.'; setTimeout(closePrivacy, 500); updateProfile();
    } catch (error) { status.textContent = api.messageFor(error); }
    finally { button.disabled = false; }
  }
  function updateProfile() {
    const label = document.getElementById('pf_ai');
    if (label) { label.textContent = current?.text_processing ? 'согласие ✓' : 'выкл'; label.style.color = current?.text_processing ? 'var(--aisy-color-success)' : 'var(--aisy-color-text-muted)'; }
  }
  async function loadPrivacy(showIfNew) {
    if (!SRV) return;
    try { current = await api.get('/api/v1/privacy/consent'); updateProfile(); if (showIfNew && current.policy_version !== current.current_policy_version) openPrivacy(); } catch (_) {}
  }
  function addProfileControls() {
    const privacyHost = document.getElementById('profile_privacy_actions');
    const dataHost = document.getElementById('profile_data_actions');
    if (!privacyHost || !dataHost || document.getElementById('privacyProfileButton')) return;
    const button = document.createElement('button'); button.id = 'privacyProfileButton'; button.type = 'button'; button.className = 'privacyProfileBtn'; button.textContent = 'Приватность и микрофон'; button.onclick = openPrivacy; privacyHost.appendChild(button);
    const exportButton = document.createElement('button'); exportButton.type = 'button'; exportButton.className = 'privacyProfileBtn'; exportButton.textContent = 'Скачать мои данные'; exportButton.onclick = () => { global.location.href = '/api/v1/account/export'; }; dataHost.appendChild(exportButton);
    const deleteButton = document.createElement('button'); deleteButton.type = 'button'; deleteButton.className = 'privacyProfileBtn'; deleteButton.style.color = 'var(--aisy-color-danger)'; deleteButton.textContent = 'Удалить аккаунт'; deleteButton.onclick = deleteAccount; dataHost.appendChild(deleteButton);
    loadPrivacy(false);
  }
  async function deleteAccount() {
    if (!global.confirm('Аккаунт, прогресс и ответы будут удалены без возможности восстановления. Продолжить?')) return;
    if (global.prompt('Для подтверждения введите DELETE') !== 'DELETE') return;
    try { const cleared = await global.EasyBoostSync?.deleteOwner((expectedOwner) => api.remove('/api/v1/account', { confirmation: 'DELETE', owner: expectedOwner }));
      if (cleared == null || cleared === false || ['GRAMMAR_MASTERY_QUEUE_LOCK_UNAVAILABLE', 'GRAMMAR_MASTERY_OWNER_CHANGED'].includes(cleared?.code)) {
        global.alert('Удаление не выполнено: браузер не поддерживает безопасную блокировку данных. Аккаунт и локальные данные сохранены. Откройте приложение в поддерживаемом браузере и повторите попытку.');
        return;
      }
      if (cleared !== true) { global.alert('Аккаунт удалён, но локальные данные пока не очищены. Закройте приложение и повторите очистку в поддерживаемом браузере.'); return; }
      global.location.reload(); }
    catch (error) { global.alert(api.messageFor(error)); }
  }
  global.openPrivacy = openPrivacy;
  global.openCalibrationPrivacy = openCalibrationPrivacy;
  registerProfileHook(addProfileControls);
  registerStartHook(() => Promise.all([loadPrivacy(true), loadCalibrationConsent()]));
})(window);
