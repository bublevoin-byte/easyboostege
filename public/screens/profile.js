/*
 * Paper A Profile keeps identity, preferences, access, privacy and account actions in one
 * portrait-first hierarchy. Remote projections are committed only while the captured owner
 * generation is current; destructive actions use the static focus-managed dialog below.
 */
import { nav, registerRouteHook } from '../router.js';
import '../modules/profile.js';
import {
  SRV, S, TOKEN, apiGet, apiIsAuthorityFailure, apiMessage, apiResponseOwner, currentUser,
  invalidateLearningAuthority, logout, profileModule, registerAuthorityReset, runProfileHooks,
  save, setTxt,
} from '../app.js';
import { presentProfilePlan } from '../commercial-copy.js';

let profileGoal = null;
let profileGoalAvailable = true;
let profileGoalAuthority = null;
let profileAction = null;
let profileActionAuthority = null;
let profileActionReturnFocus = null;
let profileActionPending = false;
let accountGlobalReturnFocus = null;
let profileActionOperation = 0;

function sameProfileAuthority(first, second) {
  return Boolean(first && second && first.owner === second.owner
    && first.ownerGeneration === second.ownerGeneration);
}

function currentProfileAuthority() {
  const owner = currentUser;
  const generation = window.EasyBoostSync?.ownerBoundGeneration?.(owner);
  return owner && Number.isSafeInteger(generation)
    ? { owner, ownerGeneration: generation } : null;
}

function profileAuthorityCurrent(authority) {
  return Boolean(authority && currentUser === authority.owner
    && window.EasyBoostSync?.ownerBoundGeneration?.(authority.owner) === authority.ownerGeneration);
}

function normalizeProfileActionDialog() {
  const dialog = document.getElementById('profile_action_dialog');
  const status = document.getElementById('profile_action_status');
  const accept = document.getElementById('profile_action_accept');
  const cancel = document.getElementById('profile_action_cancel');
  profileActionPending = false;
  delete dialog?.dataset.state;
  dialog?.removeAttribute('aria-busy');
  status?.removeAttribute('tabindex');
  if (accept) accept.disabled = false;
  if (cancel) cancel.disabled = false;
}

function resetProfileAction() {
  const dialog = document.getElementById('profile_action_dialog');
  profileActionOperation += 1;
  profileAction = null;
  profileActionAuthority = null;
  profileActionReturnFocus = null;
  normalizeProfileActionDialog();
  if (dialog?.open) dialog.close();
}

function resetProfileAuthority(authority) {
  if (authority && !sameProfileAuthority(authority, profileGoalAuthority)) return false;
  profileGoal = null;
  profileGoalAvailable = false;
  profileGoalAuthority = null;
  resetProfileAction();
  drawStudySettings();
  return true;
}

function drawStudySettings() {
  const preferences = profileModule.studyPreferences(S && S.learnerPreferences);
  const grade = document.getElementById('profile_school_grade');
  const minutes = document.getElementById('profile_session_minutes');
  const summary = document.getElementById('pf_study_summary');
  const goalValue = document.getElementById('pf_goal_value');
  if (grade) grade.value = preferences.schoolGrade == null ? '' : String(preferences.schoolGrade);
  if (minutes) minutes.value = String(preferences.preferredSessionMinutes);
  if (summary) summary.textContent = profileModule.studySummary(
    preferences, profileGoal, profileGoalAvailable,
  );
  if (goalValue) goalValue.textContent = !profileGoalAvailable
    ? 'Временно недоступна' : profileGoal
      ? 'Цель: ' + profileGoal.targetScore + '+' : 'Не настроена';
}

function bindThemePreferences() {
  const fieldset = document.getElementById('profile_theme_preferences');
  const notice = document.getElementById('profile_theme_notice');
  if (!fieldset) return;
  const controller = window.AisyTheme;
  const preference = controller?.preference || 'system';
  fieldset.querySelectorAll('input[name="profile_theme"]').forEach((input) => {
    input.checked = input.value === preference;
  });
  if (fieldset.dataset.bound) return;
  fieldset.dataset.bound = 'true';
  fieldset.addEventListener('change', (event) => {
    const input = event.target.closest('input[name="profile_theme"]');
    if (!input) return;
    if (!window.AisyTheme?.set) {
      if (notice) notice.textContent = 'Тема временно недоступна.';
      return;
    }
    window.AisyTheme.set(input.value);
    if (notice) notice.textContent = 'Оформление изменено без перезагрузки.';
  });
}

function bindStudySettings() {
  const form = document.getElementById('profile_preferences_form');
  const editGoal = document.getElementById('profile_goal_edit');
  const knownWords = document.getElementById('profile_known_words');
  const notice = document.getElementById('profile_preferences_notice');
  if (form && !form.dataset.bound) {
    form.dataset.bound = 'true';
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const grade = document.getElementById('profile_school_grade');
      const minutes = document.getElementById('profile_session_minutes');
      const preferences = profileModule.createStudyPreferences(grade?.value, minutes?.value);
      if (!preferences) {
        if (notice) notice.textContent = 'Выберите класс 8–11 или «Не указан» и длительность 15–120 минут с шагом 5.';
        return;
      }
      if (!S) {
        if (notice) notice.textContent = 'Настройки пока недоступны.';
        return;
      }
      S.learnerPreferences = preferences;
      save({ queueNow: true });
      drawStudySettings();
      if (notice) notice.textContent = navigator.onLine === false
        ? 'Сохранено на устройстве. Синхронизируем после восстановления сети.'
        : 'Настройки сохранены.';
    });
  }
  if (editGoal && !editGoal.dataset.bound) {
    editGoal.dataset.bound = 'true';
    editGoal.addEventListener('click', () => {
      nav('scr10', () => window.dispatchEvent(new CustomEvent('adaptive-goal-edit')));
    });
  }
  if (knownWords && !knownWords.dataset.bound) {
    knownWords.dataset.bound = 'true';
    knownWords.addEventListener('click', () => {
      nav('scr2', () => window.wShowKnown?.());
    });
  }
}

const PROFILE_ACTIONS = Object.freeze({
  export: {
    title: 'Скачать мои данные?',
    copy: 'Мы подготовим экспорт данных текущего аккаунта.',
    accept: 'Скачать',
  },
  delete: {
    title: 'Удалить аккаунт?',
    copy: 'Аккаунт, прогресс и ответы будут удалены без возможности восстановления.',
    accept: 'Удалить',
    confirmPhrase: true,
  },
  logout: {
    title: 'Выйти из аккаунта?',
    copy: 'На этом устройстве понадобится снова войти. Данные аккаунта не удалятся.',
    accept: 'Выйти',
  },
});

function closeProfileAction({ force = false } = {}) {
  const dialog = document.getElementById('profile_action_dialog');
  if (profileActionPending && !force) return false;
  normalizeProfileActionDialog();
  if (dialog?.open) dialog.close();
  return true;
}

function profileActionControls(dialog) {
  return [...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),a[href],[tabindex="0"]')]
    .filter((control) => !control.hidden && control.offsetParent !== null);
}

function setProfileActionPending(pending, message = '') {
  const dialog = document.getElementById('profile_action_dialog');
  const accept = document.getElementById('profile_action_accept');
  const cancel = document.getElementById('profile_action_cancel');
  const status = document.getElementById('profile_action_status');
  profileActionPending = Boolean(pending);
  if (!dialog || !accept || !cancel || !status) return;
  accept.disabled = profileActionPending;
  cancel.disabled = profileActionPending;
  if (profileActionPending) {
    dialog.dataset.state = 'pending';
    dialog.setAttribute('aria-busy', 'true');
    status.textContent = message;
    status.tabIndex = 0;
    status.focus({ preventScroll: true });
    return;
  }
  delete dialog.dataset.state;
  dialog.removeAttribute('aria-busy');
  status.removeAttribute('tabindex');
  if (dialog.open) cancel.focus({ preventScroll: true });
}

function accountActionFocusTarget() {
  return document.querySelector('#scr5.on [data-first-launch-login]:not(:disabled)')
    || document.querySelector('#scr11.on #profile_delete:not(:disabled)')
    || document.querySelector('.screen.on button:not(:disabled), .screen.on a[href]');
}

function showAccountGlobalNotice(message) {
  const notice = document.getElementById('account_action_global_notice');
  const copy = document.getElementById('account_action_global_copy');
  const dismiss = document.getElementById('account_action_global_dismiss');
  if (!notice || !copy || !dismiss) return false;
  copy.textContent = message;
  accountGlobalReturnFocus = accountActionFocusTarget();
  if (!notice.open) notice.showModal();
  requestAnimationFrame(() => dismiss.focus());
  return true;
}

function showAccountGlobalNoticeWhenSafe(message) {
  const actionDialog = document.getElementById('profile_action_dialog');
  if (actionDialog?.open) {
    actionDialog.addEventListener('close', () => showAccountGlobalNotice(message), { once: true });
    return true;
  }
  return showAccountGlobalNotice(message);
}

function profileOperationCurrent(operation, action, authority) {
  return operation === profileActionOperation && action === profileAction
    && sameProfileAuthority(authority, profileActionAuthority) && profileAuthorityCurrent(authority);
}

function openProfileAction(kind, invoker) {
  const definition = PROFILE_ACTIONS[kind];
  const dialog = document.getElementById('profile_action_dialog');
  const authority = currentProfileAuthority();
  if (!definition || !dialog || !authority) return;
  profileAction = kind;
  profileActionOperation += 1;
  profileActionAuthority = Object.freeze({ ...authority });
  profileActionReturnFocus = invoker || document.activeElement;
  normalizeProfileActionDialog();
  setTxt('profile_account_notice', '');
  setTxt('profile_action_title', definition.title);
  setTxt('profile_action_copy', definition.copy);
  setTxt('profile_action_status', '');
  document.getElementById('profile_action_status')?.removeAttribute('tabindex');
  const confirmation = document.getElementById('profile_action_confirmation');
  const phrase = document.getElementById('profile_action_phrase');
  const accept = document.getElementById('profile_action_accept');
  confirmation.hidden = !definition.confirmPhrase;
  phrase.value = '';
  accept.textContent = definition.accept;
  accept.disabled = false;
  dialog.showModal();
  const cancel = document.getElementById('profile_action_cancel');
  requestAnimationFrame(() => (definition.confirmPhrase ? phrase : cancel).focus());
}

async function downloadAccountExport(authority) {
  const blob = await window.EasyBoostApi.getBlob('/api/v1/account/export', {
    headers: { 'X-EasyBoost-Expected-Owner': authority.owner },
  });
  if (!profileAuthorityCurrent(authority)) return false;
  if (window.EasyBoostApi.responseOwner(blob) !== authority.owner) {
    await invalidateLearningAuthority(authority);
    return false;
  }
  const anchor = document.createElement('a');
  const url = URL.createObjectURL(blob);
  anchor.href = url;
  anchor.download = 'aisy-account-data.json';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return true;
}

async function executeProfileAction() {
  const action = profileAction;
  const authority = profileActionAuthority;
  const operation = ++profileActionOperation;
  const accept = document.getElementById('profile_action_accept');
  const status = document.getElementById('profile_action_status');
  const phrase = document.getElementById('profile_action_phrase');
  if (!action || !accept || !status) return;
  if (!profileAuthorityCurrent(authority)) {
    setTxt('profile_account_notice', 'Сессия изменилась. Действие отменено; проверьте текущий аккаунт.');
    closeProfileAction();
    return;
  }
  if (action === 'delete' && phrase.value.trim() !== 'DELETE') {
    status.textContent = 'Введите DELETE без кавычек.';
    phrase.focus();
    return;
  }
  accept.disabled = true;
  try {
    if (action === 'export') {
      setProfileActionPending(true, 'Готовим файл с данными…');
      if (await downloadAccountExport(authority) && profileOperationCurrent(operation, action, authority)) {
        closeProfileAction({ force: true });
      }
      return;
    }
    if (action === 'logout') {
      setProfileActionPending(true, 'Выходим…');
      await logout(authority);
      return;
    }
    setProfileActionPending(true, 'Удаляем аккаунт и локальные данные…');
    const cleared = await window.EasyBoostSync?.deleteOwner(async (expectedOwner) => {
      const result = await window.EasyBoostApi.remove('/api/v1/account', {
        confirmation: 'DELETE', owner: expectedOwner,
      }, { 'X-EasyBoost-Expected-Owner': authority.owner });
      if (!profileAuthorityCurrent(authority)
        || window.EasyBoostApi.responseOwner(result) !== authority.owner) {
        await invalidateLearningAuthority(authority);
        throw Object.assign(new Error('Аккаунт изменился. Действие отменено.'), {
          code: 'OWNER_CHANGED', status: 409,
        });
      }
      return result;
    });
    if (cleared !== true) {
      if (cleared?.code === 'GRAMMAR_MASTERY_QUEUE_WRITE_FAILED') {
        const warning = 'Аккаунт удалён на сервере, но часть локальных данных не очищена. Закройте приложение и повторите очистку в поддерживаемом браузере.';
        if (profileOperationCurrent(operation, action, authority)) {
          status.textContent = warning;
          closeProfileAction({ force: true });
        }
        showAccountGlobalNoticeWhenSafe(warning);
      } else if (!profileOperationCurrent(operation, action, authority)) {
        return;
      } else if (cleared == null || cleared === false || [
        'GRAMMAR_MASTERY_QUEUE_LOCK_UNAVAILABLE', 'GRAMMAR_MASTERY_OWNER_CHANGED',
      ].includes(cleared?.code)) {
        status.textContent = 'Удаление не выполнено. Аккаунт и локальные данные сохранены; проверьте сессию и повторите попытку.';
      } else {
        status.textContent = cleared?.message || 'Удаление не завершено. Обновите страницу и проверьте текущую сессию.';
      }
      return;
    }
    window.location.reload();
  } catch (error) {
    if (profileOperationCurrent(operation, action, authority)) {
      status.textContent = apiMessage(error, 'request');
    }
  } finally {
    if (accept.isConnected && profileOperationCurrent(operation, action, authority)) {
      setProfileActionPending(false);
    }
  }
}

function bindProfileActions() {
  const dialog = document.getElementById('profile_action_dialog');
  const cancel = document.getElementById('profile_action_cancel');
  const accept = document.getElementById('profile_action_accept');
  if (!dialog || dialog.dataset.bound) return;
  dialog.dataset.bound = 'true';
  for (const [id, action] of [
    ['profile_export', 'export'], ['profile_delete', 'delete'], ['profile_logout', 'logout'],
  ]) {
    document.getElementById(id)?.addEventListener('click', (event) => {
      openProfileAction(action, event.currentTarget);
    });
  }
  cancel.addEventListener('click', closeProfileAction);
  accept.addEventListener('click', executeProfileAction);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (profileActionPending) return;
    closeProfileAction();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const controls = profileActionControls(dialog);
    if (!controls.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  dialog.addEventListener('close', () => {
    normalizeProfileActionDialog();
    const target = profileActionReturnFocus;
    profileAction = null;
    profileActionAuthority = null;
    profileActionReturnFocus = null;
    if (target?.isConnected) requestAnimationFrame(() => target.focus());
  });
  const globalNotice = document.getElementById('account_action_global_notice');
  const globalDismiss = document.getElementById('account_action_global_dismiss');
  if (globalNotice && globalDismiss && !globalDismiss.dataset.bound) {
    globalDismiss.dataset.bound = 'true';
    globalDismiss.addEventListener('click', () => {
      globalNotice.close();
    });
    globalNotice.addEventListener('cancel', (event) => event.preventDefault());
    globalNotice.addEventListener('close', () => {
      setTxt('account_action_global_copy', '');
      const target = accountGlobalReturnFocus;
      accountGlobalReturnFocus = null;
      requestAnimationFrame(() => {
        const fallback = accountActionFocusTarget();
        if (target?.isConnected && !target.disabled) target.focus();
        else fallback?.focus();
      });
    });
  }
}

function drawProfilePlan(session) {
  const plan = presentProfilePlan(session);
  setTxt('pf_plan_name', plan.label);
  setTxt('pf_plan_summary', plan.summary);
}

async function loadAdaptiveGoal(authority) {
  const owner = authority?.owner;
  const generation = authority?.ownerGeneration;
  if (!owner || !Number.isSafeInteger(generation)) return;
  try {
    const payload = await apiGet('/api/v1/adaptive-learning/goal', {
      headers: { 'X-EasyBoost-Expected-Owner': owner },
    });
    if (!profileAuthorityCurrent(authority)) return;
    if (!payload || apiResponseOwner(payload) !== owner) {
      await invalidateLearningAuthority({ owner, ownerGeneration: generation });
      return;
    }
    profileGoal = payload.goal || null;
    profileGoalAvailable = true;
    drawStudySettings();
  } catch (error) {
    if (!profileAuthorityCurrent(authority)) return;
    if (apiIsAuthorityFailure(error)) {
      await invalidateLearningAuthority({ owner, ownerGeneration: generation });
      return;
    }
    profileGoal = null;
    profileGoalAvailable = false;
    drawStudySettings();
  }
}

function renderProfile() {
  const user = profileModule.displayName(window.__sub?.displayName || currentUser);
  setTxt('pf_ava', profileModule.initial(user));
  setTxt('pf_name', user);
  const ai = document.getElementById('pf_ai');
  if (ai) {
    ai.textContent = SRV ? 'Подключено к серверу' : 'Недоступно';
    ai.dataset.state = SRV ? 'active' : 'inactive';
  }
  drawProfilePlan(window.__sub);
  const authority = currentProfileAuthority();
  if (!sameProfileAuthority(profileGoalAuthority, authority)) {
    profileGoalAuthority = authority;
    profileGoal = null;
    profileGoalAvailable = true;
  }
  bindThemePreferences();
  bindStudySettings();
  bindProfileActions();
  drawStudySettings();
  if (SRV && TOKEN && authority) loadAdaptiveGoal(authority);
  runProfileHooks();
}

registerAuthorityReset((authority) => resetProfileAuthority(authority));
registerRouteHook((id) => { if (id === 'scr11') renderProfile(); });

export {
  drawProfilePlan, drawStudySettings, executeProfileAction, openProfileAction, renderProfile,
};
