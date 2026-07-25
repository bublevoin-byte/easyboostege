(function initializeProfileModule(global) {
  'use strict';

  const DAY_MS = 86400000;
  const GUEST = 'Гость';
  const GREETING_FALLBACK = 'друг';

  const SUBSCRIPTION_STYLES = {
    none: { color: '#C77400', background: '#FFF4DE' },
    active: { color: '#1F8A50', background: '#EAF7F0' },
    expired: { color: '#C0392B', background: '#FDEDEA' },
  };

  function displayName(user, fallback) {
    const value = String(user == null ? '' : user).trim();
    return value || fallback || GUEST;
  }

  function greeting(user) {
    return 'Привет, ' + displayName(user, GREETING_FALLBACK) + ' 👋';
  }

  function initial(user) {
    return displayName(user).charAt(0).toUpperCase();
  }

  function formatDate(timestamp) {
    const date = new Date(Number(timestamp) || 0);
    const day = ('0' + date.getDate()).slice(-2);
    const month = ('0' + (date.getMonth() + 1)).slice(-2);
    return day + '.' + month + '.' + date.getFullYear();
  }

  function subscriptionStatus(session, now) {
    if (!session || !session.sub_until) {
      return { state: 'none', daysLeft: 0, text: 'Доступ не активирован — открой бота', ...SUBSCRIPTION_STYLES.none };
    }
    const until = Number(session.sub_until) || 0;
    const daysLeft = Math.max(0, Math.ceil((until - (Number(now) || 0)) / DAY_MS));
    if (session.active) {
      return {
        state: 'active',
        daysLeft,
        text: 'Подписка до ' + formatDate(until) + ' · осталось ' + daysLeft + ' дн.',
        ...SUBSCRIPTION_STYLES.active,
      };
    }
    return {
      state: 'expired',
      daysLeft: 0,
      text: 'Подписка закончилась ' + formatDate(until),
      ...SUBSCRIPTION_STYLES.expired,
    };
  }

  global.EasyBoostProfile = Object.freeze({
    displayName,
    greeting,
    initial,
    formatDate,
    subscriptionStatus,
    GUEST,
  });
})(window);
