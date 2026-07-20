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

  async function request(url, options) {
    try { return await global.fetch(url, options); }
    catch (error) { throw new ApiError('Нет подключения к интернету.', { code: 'NETWORK_ERROR' }); }
  }

  function messageFor(error, context = 'request') {
    const status = Number(error && error.status) || 0;
    const code = String((error && error.code) || 'REQUEST_FAILED');
    if (code === 'PRIVACY_CONSENT_REQUIRED') return 'Подтвердите согласие на обработку данных в профиле.';
    if (code === 'NETWORK_ERROR' || status === 0) return 'Нет подключения к интернету. Проверьте сеть и повторите попытку.';
    if (status === 401) return 'Сессия истекла. Войдите снова.';
    if (status === 402 || status === 403) return 'Доступ неактивен. Проверьте подписку в Telegram-боте.';
    if (status === 429) return 'Лимит запросов исчерпан. Попробуйте позже.';
    if (context === 'telegram') return 'Не удалось подготовить вход через Telegram. Попробуйте ещё раз.';
    if (context === 'ai') return 'ИИ временно недоступен. Встроенные задания продолжают работать.';
    if (context === 'tts') return 'Озвучка временно недоступна.';
    if (context === 'stt') return 'Не удалось распознать запись. Попробуйте ещё раз.';
    if (status >= 500) return 'Внутренняя ошибка сервиса. Повторите попытку позже.';
    return (error && error.message) || 'Не удалось выполнить запрос.';
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
    const response = await request(baseUrl + path, { credentials: 'same-origin' });
    return parseResponse(response);
  }

  async function post(path, body) {
    const response = await request(baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
    return parseResponse(response);
  }

  async function put(path, body) {
    const response = await request(baseUrl + path, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body || {}),
    });
    return parseResponse(response);
  }

  async function remove(path, body) {
    const response = await request(baseUrl + path, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body || {}),
    });
    return parseResponse(response);
  }

  async function getBlob(path) {
    const response = await request(baseUrl + path, { credentials: 'same-origin' });
    if (!response.ok) await parseResponse(response);
    const blob = await response.blob();
    if (!blob.size) throw new ApiError('Сервер вернул пустой файл', { status: response.status });
    return blob;
  }

  async function postBinary(path, body, contentType = 'application/octet-stream') {
    const response = await request(baseUrl + path, {
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

  global.EasyBoostApi = Object.freeze({ ApiError, get, post, put, remove, getBlob, postBinary, legacyAi, messageFor });
})(window);
