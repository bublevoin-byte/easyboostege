export const EGE_MOCK_FORECAST_METADATA = Object.freeze({
  id: 'ege-mock-forecast-2026-v1',
  label: 'Прогноз тестового балла',
  disclaimer: 'Ориентировочный прогноз Easy Boost, а не официальный результат ЕГЭ.',
});

export const EGE_MOCK_RESULT_PRIMARY_MAXIMUM = 82;

export const EGE_MOCK_PRIMARY_TO_TEST_2026_V1 = Object.freeze([
  0, 1, 2, 4, 5, 6, 7, 9, 10, 11, 12, 13, 15, 16, 17, 18, 20, 21, 22, 23,
  24, 26, 27, 28, 29, 30, 32, 33, 34, 35, 37, 38, 39, 40, 41, 43, 44, 45, 46,
  48, 49, 50, 51, 52, 54, 55, 56, 57, 59, 60, 61, 62, 63, 65, 66, 67, 68, 70,
  71, 72, 73, 74, 76, 77, 78, 79, 80, 82, 83, 84, 85, 87, 88, 89, 90, 91, 93,
  94, 95, 96, 98, 99, 100,
]);

export function egeMockForecastScore(primary) {
  if (!Number.isInteger(primary) || primary < 0
    || primary >= EGE_MOCK_PRIMARY_TO_TEST_2026_V1.length) {
    throw new TypeError('EGE_MOCK_FORECAST_PRIMARY_INVALID');
  }
  return EGE_MOCK_PRIMARY_TO_TEST_2026_V1[primary];
}

export function egeMockDashboardSummaryMatchesPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.baseline == null) {
    return value.baselineAttemptId == null && value.displayedAttempts === 0;
  }
  const baseline = value.baseline;
  const primaryRange = baseline.range;
  const forecast = baseline.forecast;
  const forecastRange = forecast?.range;
  const orderedRange = (range, maximum) => Number.isInteger(range?.minimum)
    && Number.isInteger(range?.maximum)
    && range.minimum >= 0 && range.maximum <= maximum && range.minimum <= range.maximum;
  if (baseline.attemptId !== value.baselineAttemptId
    || !Number.isInteger(value.displayedAttempts) || value.displayedAttempts < 1
    || baseline.maximum !== EGE_MOCK_RESULT_PRIMARY_MAXIMUM
    || forecast?.policyId !== EGE_MOCK_FORECAST_METADATA.id
    || forecast.label !== EGE_MOCK_FORECAST_METADATA.label
    || forecast.disclaimer !== EGE_MOCK_FORECAST_METADATA.disclaimer
    || forecast.baselineEligible !== true
    || !orderedRange(primaryRange, EGE_MOCK_RESULT_PRIMARY_MAXIMUM)
    || !orderedRange(forecastRange, 100)) return false;
  if (baseline.primaryTotal == null) {
    if (forecast.score != null || primaryRange.minimum >= primaryRange.maximum) return false;
  } else if (!Number.isInteger(baseline.primaryTotal)
    || primaryRange.minimum !== baseline.primaryTotal
    || primaryRange.maximum !== baseline.primaryTotal
    || forecast.score !== egeMockForecastScore(baseline.primaryTotal)) return false;
  return forecastRange.minimum === egeMockForecastScore(primaryRange.minimum)
    && forecastRange.maximum === egeMockForecastScore(primaryRange.maximum);
}
