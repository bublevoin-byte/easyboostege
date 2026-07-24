export function evaluateAlerts({ healthOk, metrics, thresholds = {} }) {
  const limits = {
    minimumRequests: thresholds.minimumRequests ?? 20,
    serverErrorRate: thresholds.serverErrorRate ?? 0.1,
    p95DurationMs: thresholds.p95DurationMs ?? 3000,
    diskUsedPercent: thresholds.diskUsedPercent ?? 80,
    aiDailyRequests: thresholds.aiDailyRequests ?? 1000,
  };
  const alerts = {};
  if (!healthOk) {
    alerts.application_unavailable = '🔴 Easy Boost недоступен: readiness не отвечает.';
    return alerts;
  }
  if (!metrics) {
    alerts.monitoring_unavailable = '🔴 Приложение отвечает, но технические метрики недоступны.';
    return alerts;
  }
  const http = metrics.http || {};
  if (http.requests >= limits.minimumRequests && http.serverErrorRate >= limits.serverErrorRate) {
    alerts.http_5xx = `🔴 Доля HTTP 5xx: ${(http.serverErrorRate * 100).toFixed(1)}% (${http.serverErrors}/${http.requests}).`;
  }
  if (http.requests >= limits.minimumRequests && http.p95DurationMs >= limits.p95DurationMs) {
    alerts.api_latency = `🟠 API p95: ${http.p95DurationMs} мс.`;
  }
  for (const dependency of ['database', 'telegram', 'stt', 'tts']) {
    if (metrics.dependencies?.[dependency]?.lastOutcome === 'error') {
      alerts[`dependency_${dependency}`] = `🔴 Ошибка зависимости: ${dependency}.`;
    }
  }
  if ((metrics.dependencies?.ai?.consecutiveErrors || 0) >= 2) {
    alerts.ai_unavailable = '🔴 Последовательные ошибки AI: оба провайдера могут быть недоступны.';
  }
  if ((metrics.aiUsage?.requests || 0) >= limits.aiDailyRequests) {
    alerts.ai_budget = `🟠 AI-запросов за 24 часа: ${metrics.aiUsage.requests}, достигнут лимит ${limits.aiDailyRequests}.`;
  }
  if ((metrics.system?.disk?.usedPercent || 0) >= limits.diskUsedPercent) {
    alerts.disk_full = `🔴 Диск заполнен на ${metrics.system.disk.usedPercent}%.`;
  }
  if (!metrics.system?.backup?.fresh) {
    alerts.backup_stale = metrics.system?.backup?.file
      ? `🔴 Backup устарел: ${metrics.system.backup.ageHours} ч.`
      : '🔴 Актуальный backup не найден.';
  }
  if (!metrics.system?.restoreCheck?.fresh) {
    alerts.restore_check_failed = metrics.system?.restoreCheck?.status === 'failed'
      ? '🔴 Последняя проверка восстановления backup завершилась ошибкой.'
      : '🔴 Успешная проверка восстановления backup отсутствует или старше 35 дней.';
  }
  return alerts;
}
