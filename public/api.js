(function initializeEasyBoostApi(global) {
  'use strict';

  const baseUrl = global.location.origin;
  const isServerMode = global.location.protocol === 'http:' || global.location.protocol === 'https:';

  class ApiError extends Error {
    constructor(message, { status = 0, code = 'REQUEST_FAILED', requestId = '' } = {}) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      this.requestId = requestId;
    }
  }

  async function parseResponse(response) {
    const payload = await response.json().catch(() => ({}));
    if (response.ok) return payload;

    const details = payload && typeof payload.error === 'object' ? payload.error : {};
    const message = details.message || payload.error || `Ошибка ${response.status}`;
    throw new ApiError(message, {
      status: response.status,
      code: details.code,
      requestId: details.requestId || response.headers.get('x-request-id') || '',
    });
  }

  async function get(path) {
    const response = await global.fetch(baseUrl + path, { credentials: 'same-origin' });
    return parseResponse(response);
  }

  async function post(path, body) {
    const response = await global.fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
    return parseResponse(response);
  }

  async function getBlob(path) {
    const response = await global.fetch(baseUrl + path, { credentials: 'same-origin' });
    if (!response.ok) await parseResponse(response);
    const blob = await response.blob();
    if (!blob.size) throw new ApiError('Сервер вернул пустой файл', { status: response.status });
    return blob;
  }

  async function postBinary(path, body, contentType = 'application/octet-stream') {
    const response = await global.fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      credentials: 'same-origin',
      body,
    });
    return parseResponse(response);
  }

  async function legacyAi(system, user) {
    if (!isServerMode) throw new ApiError('ИИ доступен только в серверной версии приложения');
    const result = await post('/api/ai', { system, user });
    return result.text || '';
  }

  global.EasyBoostApi = Object.freeze({ ApiError, get, post, getBlob, postBinary, legacyAi });
})(window);
