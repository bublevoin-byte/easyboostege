export const ADAPTIVE_DIAGNOSTIC_START_CLAIM_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const ADAPTIVE_DIAGNOSTIC_START_CLAIM_LIMIT = 16;

export function adaptiveDiagnosticClaimExpiresAt(now) {
  return new Date(new Date(now).getTime() + ADAPTIVE_DIAGNOSTIC_START_CLAIM_RETENTION_MS);
}
