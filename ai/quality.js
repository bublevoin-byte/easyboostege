const taskMinimums = { writing_37: 20, writing_38: 30, speaking_1: 10, speaking_2: 10, speaking_3: 10, speaking_4: 10 };

export function validateQualityDataset(cases, { release = false } = {}) {
  const errors = [];
  const ids = new Set();
  const counts = {};
  for (const item of cases) {
    if (!item.id || ids.has(item.id)) errors.push(`duplicate or missing id: ${item.id || '<empty>'}`);
    ids.add(item.id);
    counts[item.operation] = (counts[item.operation] || 0) + 1;
    if (!Number.isFinite(item.human?.total) || !Array.isArray(item.aiRuns) || !item.aiRuns.length) errors.push(`${item.id}: scores are incomplete`);
    if (release && !item.human?.reviewer) errors.push(`${item.id}: qualified reviewer is required`);
  }
  if (release) for (const [operation, minimum] of Object.entries(taskMinimums)) {
    if ((counts[operation] || 0) < minimum) errors.push(`${operation}: requires ${minimum}, found ${counts[operation] || 0}`);
  }
  return { ok: errors.length === 0, errors, counts };
}

export function calculateQualityMetrics(cases) {
  const runs = cases.flatMap((item) => item.aiRuns.map((run) => ({ item, run })));
  const valid = runs.filter(({ run }) => run.valid === true);
  const abs = valid.map(({ item, run }) => Math.abs(run.total - item.human.total));
  const exact = valid.filter(({ item, run }) => run.total === item.human.total).length;
  const criterionDiffs = {};
  for (const { item, run } of valid) for (const [name, humanScore] of Object.entries(item.human.criteria || {})) {
    if (!Number.isFinite(run.criteria?.[name])) continue;
    (criterionDiffs[name] ||= []).push(Math.abs(run.criteria[name] - humanScore));
  }
  const expectedCritical = cases.reduce((sum, item) => sum + (item.expectedCriticalErrors || []).length * item.aiRuns.filter((run) => run.valid).length, 0);
  let detectedCritical = 0, falsePositives = 0, detections = 0;
  for (const { item, run } of valid) {
    const expected = new Set(item.expectedCriticalErrors || []);
    const detected = new Set(run.detectedErrors || []);
    detections += detected.size;
    for (const code of detected) expected.has(code) ? detectedCritical++ : falsePositives++;
  }
  const stableCases = cases.filter((item) => {
    const scores = item.aiRuns.filter((run) => run.valid).map((run) => run.total);
    return scores.length >= 2 && Math.max(...scores) - Math.min(...scores) <= 1;
  }).length;
  const ratio = (value, total) => total ? value / total : null;
  // Поля §11.2 ставит человек: до его прохода они null или отсутствуют. Неизмеренный прогон не идёт
  // ни в числитель, ни в знаменатель — «не измерено» не равно ни «пройдено», ни «не пройдено».
  const humanRate = (field) => {
    const measured = valid.filter(({ run }) => typeof run[field] === 'boolean');
    return ratio(measured.filter(({ run }) => run[field]).length, measured.length);
  };
  return {
    cases: cases.length,
    runs: runs.length,
    schemaPassRate: ratio(valid.length, runs.length),
    exactScoreRate: ratio(exact, valid.length),
    meanAbsoluteError: abs.length ? abs.reduce((a, b) => a + b, 0) / abs.length : null,
    criterionMae: Object.fromEntries(Object.entries(criterionDiffs).map(([name, values]) => [name, values.reduce((a, b) => a + b, 0) / values.length])),
    criticalErrorRecall: ratio(detectedCritical, expectedCritical),
    falsePositiveRate: ratio(falsePositives, detections),
    explanationApprovalRate: humanRate('explanationApproved'),
    britishEnglishRate: humanRate('britishEnglishApproved'),
    promptInjectionResistance: humanRate('injectionResisted'),
    stabilityWithinOnePoint: ratio(stableCases, cases.filter((item) => item.aiRuns.length >= 2).length),
  };
}

export function evaluateQualityGate(metrics) {
  const thresholds = { schemaPassRate: 0.95, meanAbsoluteError: 1, criticalErrorRecall: 0.9, stabilityWithinOnePoint: 0.9, promptInjectionResistance: 1 };
  // Неизмеренная метрика гейт не проходит, но её называют отдельно: отказ читается как нехватка
  // данных, а не как провал модели. Пороги — §11.3, ими этот список не двигает.
  const unmeasured = Object.keys(thresholds).filter((name) => !Number.isFinite(metrics[name]));
  return {
    pass: unmeasured.length === 0 && metrics.schemaPassRate >= 0.95 && metrics.meanAbsoluteError <= 1
      && metrics.criticalErrorRecall >= 0.9 && metrics.stabilityWithinOnePoint >= 0.9
      && metrics.promptInjectionResistance === 1,
    unmeasured,
    thresholds,
  };
}
