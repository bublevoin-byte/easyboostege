/* Update UX is deliberately non-modal: a waiting worker must never interrupt an exercise. */
import { toast } from './app.js';

const UPDATE_QUORUM_RETRY_MS = 55_000;
const UPDATE_NOTICE_COPY = 'Текущее задание не прервётся. Завершите шаг и обновите приложение.';

(function registerPwa() {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', function () {
    const notice = document.getElementById('pwa_update');
    const copy = document.getElementById('pwa_update_copy');
    const applyButton = document.getElementById('pwa_update_apply');
    const dismissButton = document.getElementById('pwa_update_dismiss');
    let offeredWorker = null;
    let consentedWorker = null;
    let controllerSeen = Boolean(navigator.serviceWorker.controller);
    let documentRootTabTraversal = false;
    let focusBeforeNotice = null;
    let quorumRetryTimer = null;
    let reloadingWorker = null;

    function stopQuorumRetry() {
      if (quorumRetryTimer !== null) window.clearInterval(quorumRetryTimer);
      quorumRetryTimer = null;
    }

    function startQuorumRetry(worker) {
      stopQuorumRetry();
      quorumRetryTimer = window.setInterval(function () {
        if (worker !== offeredWorker || worker !== consentedWorker || worker.state === 'redundant') {
          stopQuorumRetry();
          return;
        }
        worker.postMessage({ type: 'RECHECK_UPDATE_CONSENT' });
      }, UPDATE_QUORUM_RETRY_MS);
    }

    function visibleFocusTarget(element) {
      return element instanceof HTMLElement
        && element !== document.body && element !== document.documentElement
        && element.isConnected && !element.hidden && !element.closest('[hidden], [inert]')
        && element.getAttribute('aria-hidden') !== 'true'
        && !element.matches(':disabled') && element.getClientRects().length > 0;
    }

    function taskFocusTarget(element) {
      return visibleFocusTarget(element) && Boolean(element.closest('.screen.on'));
    }

    function moveFocus(target) {
      if (!visibleFocusTarget(target)) return false;
      target.focus({ preventScroll: true });
      return document.activeElement === target;
    }

    function restoreActiveScreenFocus() {
      const active = document.querySelector('.screen.on');
      if (!active) return false;
      const candidates = [
        ...active.querySelectorAll('[data-aisy-shell-focus], main, button, [href], input, textarea, select'),
        active,
      ];
      for (const target of candidates) {
        if (!target.hasAttribute('tabindex')
            && !target.matches('button, [href], input, textarea, select')) {
          target.setAttribute('tabindex', '-1');
        }
        if (moveFocus(target)) return true;
      }
      return false;
    }

    function restoreTaskFocus() {
      const target = !documentRootTabTraversal && taskFocusTarget(focusBeforeNotice)
        ? focusBeforeNotice : null;
      documentRootTabTraversal = false;
      focusBeforeNotice = null;
      if (!moveFocus(target)) restoreActiveScreenFocus();
    }

    function reportCurrentClientReady() {
      const controller = navigator.serviceWorker.controller;
      if (controller) controller.postMessage({ type: 'CURRENT_CLIENT_READY' });
    }

    function clearLegacyCallbackLocation() {
      try {
        const current = new URL(window.location.href);
        if (current.pathname === '/' && current.searchParams.has('login_code')) {
          window.history.replaceState(window.history.state, '', current.pathname);
        }
      } catch {}
    }

    /* Update workers do not claim passive tabs; only this document's exact consent may reload it. */
    function reloadForConsentedWorker(worker) {
      if (!worker || worker !== offeredWorker || worker !== consentedWorker
          || (worker.state !== 'activated' && navigator.serviceWorker.controller !== worker)) return false;
      if (reloadingWorker === worker) return true;
      reloadingWorker = worker;
      stopQuorumRetry();
      clearLegacyCallbackLocation();
      window.location.reload();
      return true;
    }

    function applyWaitingWorker() {
      const worker = offeredWorker;
      if (!worker || consentedWorker === worker) return;
      consentedWorker = worker;
      worker.addEventListener('statechange', function () {
        reloadForConsentedWorker(worker);
      });
      if (applyButton) {
        applyButton.disabled = true;
        applyButton.setAttribute('aria-busy', 'true');
        applyButton.textContent = 'Проверяем вкладки…';
      }
      if (dismissButton) dismissButton.hidden = true;
      if (copy) copy.textContent = 'Задание сохранено. Проверяем открытые вкладки Aisy.space…';
      if (reloadForConsentedWorker(worker)) return;
      worker.postMessage({ type: 'SKIP_WAITING' });
    }

    function dismissUpdate() {
      if (notice) notice.hidden = true;
      restoreTaskFocus();
      toast('Обновление отложено. Aisy.space напомнит о нём после перезагрузки.', 5000);
    }

    function offerUpdate(worker) {
      if (!worker || offeredWorker === worker) return;
      stopQuorumRetry();
      offeredWorker = worker;
      worker.postMessage({ type: 'REGISTER_LEARNER_SHELL_CLIENT' });
      consentedWorker = null;
      documentRootTabTraversal = false;
      if (taskFocusTarget(document.activeElement) && !notice?.contains(document.activeElement)) {
        focusBeforeNotice = document.activeElement;
      }
      if (notice) notice.hidden = false;
      if (applyButton) {
        applyButton.disabled = false;
        applyButton.removeAttribute('aria-busy');
        applyButton.textContent = 'Обновить после задания';
      }
      if (copy) copy.textContent = UPDATE_NOTICE_COPY;
      if (dismissButton) dismissButton.hidden = false;
      window.dispatchEvent(new CustomEvent('easyboost:update-ready'));
    }

    if (applyButton) applyButton.addEventListener('click', applyWaitingWorker);
    if (dismissButton) dismissButton.addEventListener('click', dismissUpdate);
    document.addEventListener('keydown', function (event) {
      if (notice?.hidden || event.defaultPrevented || event.key !== 'Tab') return;
      if (document.activeElement === document.body
          || document.activeElement === document.documentElement) {
        documentRootTabTraversal = true;
      }
    });
    if (notice) notice.addEventListener('focusin', function (event) {
      if (!documentRootTabTraversal && taskFocusTarget(event.relatedTarget)
          && !notice.contains(event.relatedTarget)) {
        focusBeforeNotice = event.relatedTarget;
      }
    });
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!controllerSeen) {
        controllerSeen = true;
        reportCurrentClientReady();
        return;
      }
      const controller = navigator.serviceWorker.controller;
      reloadForConsentedWorker(controller);
    });
    navigator.serviceWorker.addEventListener('message', function (event) {
      const worker = consentedWorker;
      if (event.data?.type !== 'WAITING_FOR_OTHER_TABS' || !worker
          || worker !== offeredWorker || event.source !== worker) return;
      if (copy) {
        copy.textContent = 'Обновление выбрано. Когда остальные вкладки завершат работу или закроются, эта вкладка перезагрузится автоматически. Черновик сохранён.';
      }
      if (dismissButton) dismissButton.hidden = true;
      if (applyButton) {
        applyButton.textContent = 'Ждём другие вкладки';
        applyButton.removeAttribute('aria-busy');
      }
      startQuorumRetry(worker);
      restoreTaskFocus();
    });

    navigator.serviceWorker.register('/service-worker.js', { updateViaCache: 'none' })
      .then(function (registration) {
        if (registration.waiting) offerUpdate(registration.waiting);
        registration.addEventListener('updatefound', function () {
          const worker = registration.installing;
          if (!worker) return;
          worker.addEventListener('statechange', function () {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(worker);
          });
        });
        return registration.update();
      })
      .catch(function (error) {
        console.warn('Service worker registration failed', error);
      });
    reportCurrentClientReady();
  });
}());
