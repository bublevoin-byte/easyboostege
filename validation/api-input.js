const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function classifyBodyParserError(error) {
  if (error?.type === 'entity.too.large') {
    return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Тело запроса слишком большое.' };
  }
  if (error?.type === 'entity.parse.failed') {
    return { status: 400, code: 'INVALID_JSON', message: 'Некорректный JSON.' };
  }
  return null;
}

export function validateProgress(value, limits = {}) {
  const maxBytes = limits.maxBytes ?? 512 * 1024;
  const maxDepth = limits.maxDepth ?? 10;
  const maxNodes = limits.maxNodes ?? 20_000;
  const maxArrayLength = limits.maxArrayLength ?? 2_000;
  const maxStringLength = limits.maxStringLength ?? 20_000;
  let nodes = 0;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, code: 'ROOT_MUST_BE_OBJECT' };
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > maxBytes) return { ok: false, code: 'PAYLOAD_TOO_LARGE' };

  function visit(current, depth) {
    nodes += 1;
    if (nodes > maxNodes) return 'TOO_MANY_VALUES';
    if (depth > maxDepth) return 'TOO_DEEP';
    if (typeof current === 'string') return current.length <= maxStringLength ? null : 'STRING_TOO_LONG';
    if (current === null || typeof current === 'boolean') return null;
    if (typeof current === 'number') return Number.isFinite(current) ? null : 'INVALID_NUMBER';
    if (Array.isArray(current)) {
      if (current.length > maxArrayLength) return 'ARRAY_TOO_LONG';
      for (const item of current) { const error = visit(item, depth + 1); if (error) return error; }
      return null;
    }
    if (typeof current !== 'object') return 'INVALID_VALUE';
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) return 'INVALID_OBJECT';
    for (const [key, item] of Object.entries(current)) {
      if (FORBIDDEN_KEYS.has(key)) return 'FORBIDDEN_KEY';
      if (key.length > 300) return 'KEY_TOO_LONG';
      const error = visit(item, depth + 1);
      if (error) return error;
    }
    return null;
  }

  const code = visit(value, 0);
  return code ? { ok: false, code } : { ok: true, data: value };
}
