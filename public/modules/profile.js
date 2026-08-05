(function initializeProfileModule(global) {
  'use strict';

  const DAY_MS = 86400000;
  const GUEST = 'Гость';
  const GREETING_FALLBACK = 'друг';
  const DEFAULT_SESSION_MINUTES = 30;

  function validSchoolGrade(value) {
    return Number.isInteger(value) && value >= 8 && value <= 11;
  }

  function validSessionMinutes(value) {
    return Number.isInteger(value) && value >= 15 && value <= 120 && value % 5 === 0;
  }

  function studyPreferences(value) {
    const source = value && typeof value === 'object' && value.version === 1 ? value : {};
    return {
      version: 1,
      schoolGrade: validSchoolGrade(source.schoolGrade) ? source.schoolGrade : null,
      preferredSessionMinutes: validSessionMinutes(source.preferredSessionMinutes)
        ? source.preferredSessionMinutes : DEFAULT_SESSION_MINUTES,
    };
  }

  function createStudyPreferences(schoolGrade, preferredSessionMinutes) {
    const normalizedGrade = schoolGrade === '' || schoolGrade == null ? null : Number(schoolGrade);
    const normalizedMinutes = Number(preferredSessionMinutes);
    if (normalizedGrade !== null && !validSchoolGrade(normalizedGrade)) return null;
    if (!validSessionMinutes(normalizedMinutes)) return null;
    return {
      version: 1,
      schoolGrade: normalizedGrade,
      preferredSessionMinutes: normalizedMinutes,
    };
  }

  function studySummary(preferences, goal, goalAvailable = true) {
    const normalized = studyPreferences(preferences);
    const grade = normalized.schoolGrade == null
      ? 'Класс не указан' : normalized.schoolGrade + ' класс';
    if (!goalAvailable) return grade + ' · цель временно недоступна';
    const targetScore = goal && Number.isInteger(goal.targetScore)
      && goal.targetScore >= 0 && goal.targetScore <= 100 ? goal.targetScore : null;
    return grade + ' · ' + (targetScore == null
      ? 'цель не настроена' : 'цель: ' + targetScore + '+ баллов');
  }

  // Text colours meet WCAG 2.1 AA (4.5:1) against their own tinted background.
  const SUBSCRIPTION_STYLES = {
    none: { color: '#A56000', background: '#FFF4DE' },
    active: { color: '#1D7F4A', background: '#EAF7F0' },
    expired: { color: '#A83226', background: '#FDEDEA' },
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

  function voiceTutorStatus(session, paymentRequest = null) {
    const entitled = Boolean(session && session.entitlements && session.entitlements.voice_tutor);
    if (!entitled) {
      const pending = paymentRequest?.status === 'new';
      const rejected = paymentRequest?.status === 'rejected';
      const requestCode = paymentRequest?.id ? String(paymentRequest.id).slice(0, 8) : '';
      return {
        state: pending ? 'pending' : 'paywall',
        title: 'Voice Tutor · Premium',
        text: pending
          ? `Заявка #${requestCode} · статус: ожидает подтверждения`
          : rejected
            ? `Заявка #${requestCode} · статус: отклонена`
            : 'Голосовой разбор ошибок доступен в Premium',
        actionLabel: pending ? '' : (rejected ? 'Отправить заявку снова' : 'Запросить Premium'),
        color: '#8A4B00',
        background: '#FFF4DE',
      };
    }
    const voice = session.voice_tutor || {};
    const dailyMinutes = Math.ceil(Math.max(0, Number(voice.daily_remaining_seconds) || 0) / 60);
    const monthlyMinutes = Math.ceil(Math.max(0, Number(voice.monthly_remaining_seconds) || 0) / 60);
    return {
      state: 'premium',
      title: 'Voice Tutor · Premium',
      text: 'Осталось ' + dailyMinutes + ' мин сегодня · ' + monthlyMinutes + ' мин в этом месяце',
      actionLabel: '',
      color: '#1D7F4A',
      background: '#EAF7F0',
    };
  }

  global.EasyBoostProfile = Object.freeze({
    displayName,
    greeting,
    initial,
    formatDate,
    subscriptionStatus,
    voiceTutorStatus,
    studyPreferences,
    createStudyPreferences,
    studySummary,
    DEFAULT_SESSION_MINUTES,
    GUEST,
  });
})(window);
