(function initializeEasyBoostAuth(global) {
  'use strict';

  const api = global.EasyBoostApi;
  const isServerMode = global.location.protocol === 'http:' || global.location.protocol === 'https:';
  const legacyStorageKeys = Object.freeze(['eb_token', 'eb_key', 'eb_groq', 'eb_model', 'eb_groq_model']);

  function clearLegacySecrets() {
    try { legacyStorageKeys.forEach((key) => global.localStorage.removeItem(key)); }
    catch (_) {}
  }

  async function requestLogout() {
    return api.post('/api/v1/logout', {});
  }

  async function currentSession(options = {}) {
    return api.get('/api/v1/me', options);
  }

  clearLegacySecrets();
  global.EasyBoostAuth = Object.freeze({
    isServerMode,
    logout: requestLogout,
    currentSession,
  });
})(window);
