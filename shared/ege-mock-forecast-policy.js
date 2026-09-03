import {
  EGE_MOCK_FORECAST_METADATA,
  EGE_MOCK_PRIMARY_TO_TEST_2026_V1,
  EGE_MOCK_RESULT_PRIMARY_MAXIMUM,
} from './ege-mock-forecast-metadata.js';

export { EGE_MOCK_RESULT_PRIMARY_MAXIMUM, egeMockForecastScore } from './ege-mock-forecast-metadata.js';

export const EGE_MOCK_FORECAST_POLICY = Object.freeze({
  ...EGE_MOCK_FORECAST_METADATA,
  primaryMaximum: EGE_MOCK_RESULT_PRIMARY_MAXIMUM,
  primaryToTest: EGE_MOCK_PRIMARY_TO_TEST_2026_V1,
});
