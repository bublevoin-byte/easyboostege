export const EGE_MOCK_ATTEMPT_POLICY = Object.freeze({
  id: 'ege-mock-attempt-policy-v1',
  writtenMinutes: 190,
  oralStartWindowDays: 30,
  oralMinutes: 17,
});

export const EGE_MOCK_WRITTEN_DURATION_MS = EGE_MOCK_ATTEMPT_POLICY.writtenMinutes * 60_000;
export const EGE_MOCK_ORAL_START_WINDOW_MS = EGE_MOCK_ATTEMPT_POLICY.oralStartWindowDays * 86_400_000;
export const EGE_MOCK_ORAL_DURATION_MS = EGE_MOCK_ATTEMPT_POLICY.oralMinutes * 60_000;

export function egeMockPublicFormWithPolicy(form) {
  if (!form) return null;
  return Object.freeze({
    ...structuredClone(form),
    attemptPolicy: { ...EGE_MOCK_ATTEMPT_POLICY },
  });
}
