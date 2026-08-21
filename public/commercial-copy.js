const PUBLIC_PLAN_LABELS = Object.freeze({
  free: 'Free',
  premium: 'Premium',
});

function capability(id, label, available) {
  return { id, label, available: available === true };
}

function presentPublicBrand(copy) {
  return String(copy ?? '').replaceAll('Easy Boost', 'Aisy.space');
}

function presentPublicPlan(access) {
  const source = access && typeof access === 'object' ? access : {};
  const internalTier = String(source.tier || 'free').toLowerCase();
  const capabilities = source.capabilities && typeof source.capabilities === 'object'
    ? source.capabilities : {};
  const premium = internalTier === 'base' || internalTier === 'premium';
  const continuousPlan = premium && capabilities.continuousPlan !== false;
  const deepDiagnostic = internalTier === 'premium' && capabilities.deepDiagnostic === true;
  const detailedReports = internalTier === 'premium' && capabilities.detailedReports === true;
  const items = [
    capability('personal-plan', 'Персональный план', continuousPlan),
    capability('deep-diagnostic', 'Глубокая диагностика', deepDiagnostic),
    capability('detailed-reports', 'Подробные отчёты', detailedReports),
  ];

  if (!premium) {
    return {
      id: 'free',
      label: PUBLIC_PLAN_LABELS.free,
      summary: 'Основная практика доступна. Персональный план и расширенные возможности требуют Premium.',
      capabilities: items,
    };
  }
  if (deepDiagnostic && detailedReports) {
    return {
      id: 'premium',
      label: PUBLIC_PLAN_LABELS.premium,
      summary: 'Персональный план, глубокая диагностика и подробные отчёты доступны.',
      capabilities: items,
    };
  }
  return {
    id: 'premium',
    label: PUBLIC_PLAN_LABELS.premium,
    summary: 'Персональный план доступен. Глубокая диагностика и подробные отчёты не входят в текущий доступ.',
    capabilities: items,
  };
}

function presentProfilePlan(session) {
  const source = session && typeof session === 'object' ? session : {};
  const voiceTutorAvailable = source.entitlements?.voice_tutor === true;
  const premium = source.active === true || voiceTutorAvailable;
  if (!premium) {
    return {
      id: 'free',
      label: PUBLIC_PLAN_LABELS.free,
      summary: 'Основная практика доступна без оплаты.',
      voiceTutorAvailable: false,
    };
  }
  return {
    id: 'premium',
    label: PUBLIC_PLAN_LABELS.premium,
    summary: voiceTutorAvailable
      ? 'Основной учебный доступ и голосовой разбор Аси активны.'
      : 'Основной учебный доступ активен. Голосовой разбор Аси не входит в текущий доступ.',
    voiceTutorAvailable,
  };
}

const COMMERCIAL_ERROR_COPY = Object.freeze({
  ADAPTIVE_FREE_DEMO_USED: 'Бесплатное пробное занятие уже использовано. Для следующих персональных занятий нужен Premium.',
  ADAPTIVE_BASE_REQUIRED: 'Для постоянного персонального плана нужен Premium.',
  ADAPTIVE_PREMIUM_REQUIRED: 'Глубокая диагностика и подробные отчёты доступны с Premium.',
  ADAPTIVE_FREE_DIAGNOSTIC_USED: 'Бесплатная короткая диагностика уже пройдена. Продолжение доступно с Premium.',
});

function presentCommercialError(error, fallback = 'Не удалось проверить доступ. Повторите попытку.') {
  return COMMERCIAL_ERROR_COPY[String(error?.code || '')] || fallback;
}

export {
  PUBLIC_PLAN_LABELS,
  presentCommercialError,
  presentProfilePlan,
  presentPublicBrand,
  presentPublicPlan,
};
