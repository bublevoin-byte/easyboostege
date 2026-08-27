const PUBLIC_PLAN_LABELS = Object.freeze({
  active: 'Активный доступ',
  limited: 'Ограниченный доступ',
  inactive: 'Доступ не активирован',
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
      id: 'inactive',
      label: PUBLIC_PLAN_LABELS.inactive,
      summary: 'Обратитесь к оператору, который выдал доступ.',
      capabilities: items,
    };
  }
  if (deepDiagnostic && detailedReports) {
    return {
      id: 'active',
      label: PUBLIC_PLAN_LABELS.active,
      summary: 'Персональный план, глубокая диагностика и подробные отчёты доступны.',
      capabilities: items,
    };
  }
  return {
    id: 'active',
    label: PUBLIC_PLAN_LABELS.active,
    summary: 'Персональный план доступен. Глубокая диагностика и подробные отчёты не входят в текущий доступ.',
    capabilities: items,
  };
}

function presentProfilePlan(session) {
  const source = session && typeof session === 'object' ? session : {};
  const active = source.active === true;
  const voiceTutorAvailable = active && source.entitlements?.voice_tutor === true;
  if (!active) {
    return {
      id: 'inactive',
      label: PUBLIC_PLAN_LABELS.inactive,
      summary: 'Обратитесь к оператору, который выдал доступ.',
      voiceTutorAvailable: false,
    };
  }
  return {
    id: 'active',
    label: PUBLIC_PLAN_LABELS.active,
    summary: voiceTutorAvailable
      ? 'Основной учебный доступ и голосовой разбор Аси активны.'
      : 'Основной учебный доступ активен. Голосовой разбор Аси не входит в текущий доступ.',
    voiceTutorAvailable,
  };
}

const COMMERCIAL_ERROR_COPY = Object.freeze({
  ADAPTIVE_FREE_DEMO_USED: 'Текущего доступа недостаточно. Обратитесь к оператору, который выдал доступ.',
  ADAPTIVE_BASE_REQUIRED: 'Текущего доступа недостаточно. Обратитесь к оператору, который выдал доступ.',
  ADAPTIVE_PREMIUM_REQUIRED: 'Эта возможность не входит в выданный доступ. Обратитесь к оператору.',
  ADAPTIVE_FREE_DIAGNOSTIC_USED: 'Текущего доступа недостаточно. Обратитесь к оператору, который выдал доступ.',
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
