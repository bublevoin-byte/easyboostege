import { EGE_MOCK_ORAL_DURATION_MS } from '../shared/ege-mock-oral-contract.js';

export const EGE_MOCK_ATTEMPT_POLICY = Object.freeze({
  id: 'ege-mock-attempt-policy-v1',
  writtenMinutes: 190,
  oralStartWindowDays: 30,
  oralMinutes: EGE_MOCK_ORAL_DURATION_MS / 60_000,
});

export const EGE_MOCK_WRITTEN_DURATION_MS = EGE_MOCK_ATTEMPT_POLICY.writtenMinutes * 60_000;
export const EGE_MOCK_ORAL_START_WINDOW_MS = EGE_MOCK_ATTEMPT_POLICY.oralStartWindowDays * 86_400_000;
export { EGE_MOCK_ORAL_DURATION_MS };

export function egeMockPublicFormWithPolicy(form) {
  if (!form) return null;
  return Object.freeze({
    ...structuredClone(form),
    attemptPolicy: { ...EGE_MOCK_ATTEMPT_POLICY },
  });
}
