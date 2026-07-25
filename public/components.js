(function initEasyBoostComponents(global) {
  'use strict';

  let notificationTimer = null;

  function byId(id) {
    return global.document.getElementById(id);
  }

  function setText(id, value) {
    const element = byId(id);
    if (element) element.textContent = String(value ?? '');
    return element;
  }

  function setWidth(id, value) {
    const element = byId(id);
    if (!element) return null;
    const percent = Math.max(0, Math.min(100, Number(value) || 0));
    element.style.width = `${Math.round(percent)}%`;
    return element;
  }

  function setRingOffset(id, total, value) {
    const element = byId(id);
    if (!element) return null;
    const circumference = Math.max(0, Number(total) || 0);
    const percent = Math.max(0, Math.min(100, Number(value) || 0));
    element.setAttribute('stroke-dashoffset', String(Math.round(circumference * (1 - percent / 100))));
    return element;
  }

  function elementText(element) {
    return String(element?.textContent || '').trim();
  }

  function makeInteractive(element, label, handler) {
    if (!element || typeof handler !== 'function' || element.dataset.ebInteractive === 'true') return element;
    element.dataset.ebInteractive = 'true';
    element.classList.add('clk');
    if (!/^(BUTTON|A)$/u.test(element.tagName)) {
      element.setAttribute('role', 'button');
      element.setAttribute('tabindex', '0');
    }
    if (label && !element.getAttribute('aria-label')) element.setAttribute('aria-label', label);
    element.addEventListener('click', (event) => {
      event.stopPropagation();
      handler();
    });
    element.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      handler();
    });
    return element;
  }

  // Colour alone must not carry the verdict, so every marked answer also gets a glyph and a label.
  const ANSWER_MARKS = {
    correct: { background: '#EAF7F0', borderColor: '#198049', color: '#1D7F4A', mark: '✓', label: 'верно' },
    wrong: { background: '#FDEDEA', borderColor: '#C23A39', color: '#A83226', mark: '✗', label: 'неверно' },
  };

  function markAnswer(element, state) {
    const style = ANSWER_MARKS[state];
    if (!element || !style || element.dataset.ebMark) return element;
    element.dataset.ebMark = state;
    const text = elementText(element);
    element.style.background = style.background;
    element.style.borderColor = style.borderColor;
    element.style.color = style.color;
    const mark = global.document.createElement('span');
    mark.className = 'ansmark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = style.mark;
    element.appendChild(mark);
    element.setAttribute('aria-label', `${text} — ${style.label}`);
    return element;
  }

  function bindText(screenId, label, handler) {
    const screen = byId(screenId);
    if (!screen) return [];
    const elements = [...screen.querySelectorAll('div,span,button,a')]
      .filter((element) => elementText(element) === label && element.children.length <= 2);
    elements.forEach((element) => makeInteractive(element, label, handler));
    return elements;
  }

  function animate(id, name, duration = '180ms') {
    const element = byId(id);
    if (!element) return null;
    const cssDuration = typeof duration === 'number'
      ? `${Math.max(0, duration)}ms`
      : (/^\d*\.?\d+(?:ms|s)$/u.test(String(duration)) ? String(duration) : '180ms');
    element.style.animation = 'none';
    void element.offsetWidth;
    element.style.animation = `${name} ${cssDuration} cubic-bezier(.25,.75,.35,1)`;
    return element;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function ensureLiveRegion(id = 'toast') {
    let element = byId(id);
    if (element) return element;
    element = global.document.createElement('div');
    element.id = id;
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');
    element.setAttribute('aria-atomic', 'true');
    global.document.body.appendChild(element);
    return element;
  }

  function notify(message, duration = 2600, id = 'toast') {
    const element = ensureLiveRegion(id);
    element.textContent = String(message ?? '');
    element.style.display = 'block';
    global.clearTimeout(notificationTimer);
    if (duration !== 0) {
      notificationTimer = global.setTimeout(() => {
        element.style.display = 'none';
      }, Math.max(0, Number(duration) || 2600));
    }
    return element;
  }

  global.EasyBoostComponents = Object.freeze({
    setText,
    setWidth,
    setRingOffset,
    elementText,
    makeInteractive,
    markAnswer,
    bindText,
    animate,
    escapeHtml,
    ensureLiveRegion,
    notify,
  });
})(window);
