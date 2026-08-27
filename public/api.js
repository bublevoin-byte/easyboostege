(function initializeEasyBoostApi(global) {
  'use strict';

  const baseUrl = global.location.origin;
  const isServerMode = global.location.protocol === 'http:' || global.location.protocol === 'https:';
  const responseOwners = new WeakMap();
  const responseServerTimes = new WeakMap();

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
    if (code === 'ADAPTIVE_SESSION_COVERAGE_GAP') return 'Из доступных встроенных заданий нельзя составить занятие выбранной длительности. Выберите другое время или обновите план.';
    if (code === 'NETWORK_ERROR' || status === 0) return 'Нет подключения к интернету. Проверьте сеть и повторите попытку.';
    if (status === 401) return 'Сессия истекла. Войдите снова.';
    if (status === 402 || status === 403) return 'Доступ неактивен. Обратитесь к оператору, который выдал доступ.';
    if (status === 429) return 'Лимит запросов исчерпан. Попробуйте позже.';
    if (context === 'telegram') return 'Не удалось подготовить вход через Telegram. Попробуйте ещё раз.';
    if (context === 'ai') return 'ИИ временно недоступен. Встроенные задания продолжают работать.';
    if (context === 'tts') return 'Озвучка временно недоступна.';
    if (context === 'stt') return 'Не удалось распознать запись. Попробуйте ещё раз.';
    if (status >= 500) return 'Внутренняя ошибка сервиса. Повторите попытку позже.';
    return (error && error.message) || 'Не удалось выполнить запрос.';
  }

  function isAuthorityFailure(error) {
    const status = Number(error && error.status) || 0;
    const code = String((error && error.code) || '');
    return code === 'OWNER_CHANGED' || status === 401 || (status === 403 && code === 'FORBIDDEN');
  }

  function canUseOfflineFallback(error) {
    const status = Number(error && error.status) || 0;
    const code = String((error && error.code) || '');
    if (isAuthorityFailure(error)) return false;
    return ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'TIMEOUT'].includes(code) || status >= 500;
  }

  function responseOwner(payload) {
    return payload && typeof payload === 'object' ? (responseOwners.get(payload) || '') : '';
  }

  function responseServerTime(payload) {
    return payload && typeof payload === 'object' ? (responseServerTimes.get(payload) ?? null) : null;
  }

  async function parseResponse(response) {
    const payload = await response.json().catch(() => ({}));
    if (response.ok) {
      const owner = String(response.headers.get('x-easyboost-response-owner') || '').trim();
      const serverTime = Date.parse(String(response.headers.get('date') || ''));
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        if (owner) responseOwners.set(payload, owner);
        if (Number.isFinite(serverTime)) responseServerTimes.set(payload, serverTime);
      }
      return payload;
    }

    const details = payload && typeof payload.error === 'object' ? payload.error : {};
    const message = details.message || payload.error || `Ошибка ${response.status}`;
    throw new ApiError(message, {
      status: response.status,
      code: details.code,
      requestId: details.requestId || response.headers.get('x-request-id') || '',
    });
  }

  async function get(path, options = {}) {
    const response = await request(baseUrl + path, { ...options, credentials: 'same-origin' });
    return parseResponse(response);
  }

  async function post(path, body, headers = {}) {
    const response = await request(baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
    return parseResponse(response);
  }

  async function postIdempotent(path, body, idempotencyKey, headers = {}, options = {}) {
    const response = await request(baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': String(idempotencyKey || ''), ...headers },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
      signal: options.signal,
    });
    return parseResponse(response);
  }

  async function put(path, body, headers = {}) {
    const response = await request(baseUrl + path, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers }, credentials: 'same-origin', body: JSON.stringify(body || {}),
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

  async function postBinary(path, body, contentType = 'application/octet-stream', headers = {}) {
    const response = await request(baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': contentType, ...headers },
      credentials: 'same-origin',
      body,
    });
    return parseResponse(response);
  }

  async function generateContent(operation, payload = {}, headers = {}) {
    if (!isServerMode) throw new ApiError('ИИ доступен только в серверной версии приложения');
    const result = await post('/api/v1/ai/generate-content', { operation, ...payload }, headers);
    const data = result.data;
    if (data && typeof data === 'object') {
      const owner = responseOwner(result);
      const serverTime = responseServerTime(result);
      if (owner) responseOwners.set(data, owner);
      if (Number.isFinite(serverTime)) responseServerTimes.set(data, serverTime);
    }
    return data;
  }

  global.EasyBoostApi = Object.freeze({
    ApiError, get, post, postIdempotent, put, remove, getBlob, postBinary, generateContent, messageFor,
    responseOwner, responseServerTime, isAuthorityFailure, canUseOfflineFallback,
  });
})(window);
