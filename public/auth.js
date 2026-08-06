(function initializeEasyBoostAuth(global) {
  'use strict';

  const api = global.EasyBoostApi;
  const isServerMode = global.location.protocol === 'http:' || global.location.protocol === 'https:';
  const legacyStorageKeys = Object.freeze(['eb_token', 'eb_key', 'eb_groq', 'eb_model', 'eb_groq_model']);

  function clearLegacySecrets() {
    try { legacyStorageKeys.forEach((key) => global.localStorage.removeItem(key)); }
    catch (_) {}
  }

  async function login(username, password) {
    return api.post('/api/v1/login', { username, password });
  }

  async function register(username, password) {
    return api.post('/api/v1/register', { username, password });
  }

  async function requestLogout() {
    return api.post('/api/v1/logout', {});
  }

  async function currentSession(options = {}) {
    return api.get('/api/v1/me', options);
  }

  async function startTelegramLogin() {
    return api.post('/api/v1/tg/start', {});
  }

  async function checkTelegramLogin(code) {
    return api.get(`/api/v1/tg/check?code=${encodeURIComponent(code)}`);
  }

  clearLegacySecrets();
  global.EasyBoostAuth = Object.freeze({
    isServerMode,
    login,
    register,
    logout: requestLogout,
    currentSession,
    startTelegramLogin,
    checkTelegramLogin,
  });
})(window);
