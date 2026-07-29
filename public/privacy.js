/*
 * Режим работы и точки подключения к профилю раньше искались в глобальной области.
 * В модуле их не видно, а `typeof SRV === 'undefined'` тихо отключил бы согласия целиком,
 * поэтому зависимости приходят импортом — импортированное имя остаётся живым и видит startDemo().
 */
import {DEMO_MODE, SRV, registerProfileHook, registerStartHook} from './app.js';

(function initializePrivacyControls(global) {
  'use strict';
  const api = global.EasyBoostApi;
  let current = null;

  function ensureSheet() {
    if (document.getElementById('privacySheet')) return;
    const style = document.createElement('style');
    style.textContent = `
      #privacySheet{position:fixed;inset:0;z-index:500;display:none}#privacySheet.open{display:block}
      #privacySheet .privacyBackdrop{position:absolute;inset:0;background:rgba(20,20,30,.55)}
      #privacySheet .privacyPanel{position:absolute;left:50%;bottom:0;transform:translateX(-50%);width:min(100%,430px);max-height:92dvh;overflow:auto;background:#fff;border-radius:26px 26px 0 0;padding:20px 20px calc(24px + env(safe-area-inset-bottom));box-shadow:0 -16px 50px rgba(20,20,30,.24)}
      #privacySheet h2{margin:0;color:#2B2B2B;font:800 21px Nunito,Manrope,sans-serif}#privacySheet p,#privacySheet li{color:#5B5F66;font:600 13px/1.55 Manrope,sans-serif}
      .privacyChoice{display:grid;grid-template-columns:24px 1fr;gap:12px;align-items:start;padding:14px;margin:10px 0;border:1.5px solid #E4E6EA;border-radius:16px;cursor:pointer}.privacyChoice input{width:22px;height:22px;min-height:0;accent-color:#F2683F;margin:1px 0}.privacyChoice b{display:block;color:#2B2B2B;font-size:14px}.privacyChoice span{display:block;color:#747982;font-size:12px;line-height:1.45;margin-top:3px}
      .privacyActions{display:flex;gap:10px;margin-top:16px}.privacyBtn{min-height:48px;border-radius:15px;border:0;padding:0 16px;font:800 14px Manrope,sans-serif;cursor:pointer}.privacyBtn:disabled{opacity:.48;cursor:not-allowed}.privacyPrimary{flex:1;background:#F2683F;color:#fff}.privacySecondary{background:#F1F2F4;color:#454950}
      .privacyLink{color:#B33C19;font-weight:800}.privacyStatus{min-height:20px;color:#B42318;font:700 12px/1.4 Manrope,sans-serif;margin-top:8px}
      .privacyProfileBtn{width:100%;min-height:48px;border:0;border-top:1px solid #F4F5F6;background:#fff;padding:12px 16px;text-align:left;font:700 14px Manrope,sans-serif;color:#2B2B2B;cursor:pointer}
    `;
    document.head.appendChild(style);
    const sheet = document.createElement('div');
    sheet.id = 'privacySheet';
    sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-labelledby', 'privacyTitle');
    sheet.innerHTML = `<div class="privacyBackdrop"></div><section class="privacyPanel"><h2 id="privacyTitle">Приватность и ИИ</h2>
      <p>Обычные задания работают без передачи данных ИИ. Для дополнительных функций выберите, что разрешаете отправлять внешним провайдерам.</p>
      <ul><li>Текст ответа — для проверки через настроенного провайдера xAI или Groq.</li><li>Аудиозапись — только для распознавания речи через xAI.</li><li>ИИ-оценка ориентировочная и не является официальной.</li></ul>
      <label class="privacyChoice"><input id="privacyText" type="checkbox"><span><b>Обработка текста</b><span>Разрешить отправку текста учебного ответа AI-провайдеру.</span></span></label>
      <label class="privacyChoice"><input id="privacyVoice" type="checkbox"><span><b>Обработка голоса</b><span>Разрешить отправку записи внешнему STT-провайдеру. Сохранение исходного аудио не предусмотрено.</span></span></label>
      <a class="privacyLink" href="/privacy.html" target="_blank" rel="noopener">Открыть политику конфиденциальности</a>
      <div id="privacyStatus" class="privacyStatus" role="status" aria-live="polite"></div>
      <div class="privacyActions"><button id="privacyClose" class="privacyBtn privacySecondary" type="button">Позже</button><button id="privacySave" class="privacyBtn privacyPrimary" type="button">Сохранить выбор</button></div></section>`;
    document.body.appendChild(sheet);
    sheet.querySelector('.privacyBackdrop').onclick = closePrivacy;
    document.getElementById('privacyClose').onclick = closePrivacy;
    document.getElementById('privacySave').onclick = savePrivacy;
    sheet.addEventListener('keydown', (event) => { if (event.key === 'Escape') closePrivacy(); });
  }

  function openPrivacy() {
    ensureSheet();
    document.getElementById('privacyText').checked = Boolean(current?.text_processing);
    document.getElementById('privacyVoice').checked = Boolean(current?.voice_processing);
    document.getElementById('privacyStatus').textContent = '';
    document.getElementById('privacySheet').classList.add('open');
    document.getElementById('privacyText').focus();
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
    if (label) { label.textContent = current?.text_processing ? 'согласие ✓' : 'выкл'; label.style.color = current?.text_processing ? '#1F8A50' : '#8A8F98'; }
  }
  async function loadPrivacy(showIfNew) {
    if (!SRV || DEMO_MODE) return;
    try { current = await api.get('/api/v1/privacy/consent'); updateProfile(); if (showIfNew && !current.policy_version) openPrivacy(); } catch (_) {}
  }
  function addProfileControls() {
    const label = document.getElementById('pf_ai'); const card = label?.closest('div[style*="display:flex"]')?.parentElement;
    if (!card || document.getElementById('privacyProfileButton')) return;
    const button = document.createElement('button'); button.id = 'privacyProfileButton'; button.type = 'button'; button.className = 'privacyProfileBtn'; button.textContent = 'Настройки приватности'; button.onclick = openPrivacy; card.appendChild(button);
    const exportButton = document.createElement('button'); exportButton.type = 'button'; exportButton.className = 'privacyProfileBtn'; exportButton.textContent = 'Скачать мои данные'; exportButton.onclick = () => { global.location.href = '/api/v1/account/export'; }; card.appendChild(exportButton);
    const deleteButton = document.createElement('button'); deleteButton.type = 'button'; deleteButton.className = 'privacyProfileBtn'; deleteButton.style.color = '#B42318'; deleteButton.textContent = 'Удалить аккаунт'; deleteButton.onclick = deleteAccount; card.appendChild(deleteButton);
    loadPrivacy(false);
  }
  async function deleteAccount() {
    if (!global.confirm('Аккаунт, прогресс и ответы будут удалены без возможности восстановления. Продолжить?')) return;
    if (global.prompt('Для подтверждения введите DELETE') !== 'DELETE') return;
    try { await api.remove('/api/v1/account', { confirmation: 'DELETE' }); global.localStorage.removeItem('eb_current'); global.location.reload(); }
    catch (error) { global.alert(api.messageFor(error)); }
  }
  global.openPrivacy = openPrivacy;
  registerProfileHook(addProfileControls);
  registerStartHook(() => loadPrivacy(true));
})(window);
