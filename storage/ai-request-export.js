const AI_REQUEST_EXPORT_FIELDS = Object.freeze([
  ['id', 'id'],
  ['operation', 'operation'],
  ['provider', 'provider'],
  ['model', 'model'],
  ['prompt_version', 'promptVersion'],
  ['context_fingerprint', 'contextFingerprint'],
  ['status', 'status'],
  ['duration_ms', 'durationMs'],
  ['error_code', 'errorCode'],
  ['prompt_tokens', 'promptTokens'],
  ['completion_tokens', 'completionTokens'],
  ['estimated_cost_microusd', 'estimatedCostMicrousd'],
]);

function field(row, snakeCase, camelCase) {
  if (Object.hasOwn(row, snakeCase)) return row[snakeCase];
  if (Object.hasOwn(row, camelCase)) return row[camelCase];
  return null;
}

function exportedTimestamp(value) {
  const instant = value instanceof Date ? value : new Date(value);
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : null;
}

// This allowlist is the only account-export projection for AI metering rows. In particular,
// owner and idempotency/claim material can never enter an export through object spreading.
export function aiRequestExportDto(row) {
  const source = row && typeof row === 'object' ? row : {};
  return Object.freeze({
    ...Object.fromEntries(AI_REQUEST_EXPORT_FIELDS.map(([snakeCase, camelCase]) => (
      [snakeCase, field(source, snakeCase, camelCase)]
    ))),
    created_at: exportedTimestamp(field(source, 'created_at', 'createdAt')),
  });
}
