(function initializeEasyBoostStore(global) {
  'use strict';

  const sync = global.EasyBoostSync;

  function dataKey(username) {
    return `eb_data_${username || 'guest'}`;
  }

  function normalize(value) {
    const state = value && typeof value === 'object' ? value : {};
    state.box = state.box || {};
    state.wstatus = state.wstatus || {};
    state.learned = state.learned == null ? 0 : state.learned;
    state.streak = state.streak == null ? 0 : state.streak;
    state.lastDay = state.lastDay || null;
    state.dayMin = state.dayMin == null ? 0 : state.dayMin;
    state.dayMinDate = state.dayMinDate || new Date().toISOString().slice(0, 10);
    state.essays = state.essays || 0;
    state.speak = state.speak || 0;
    state.srs = state.srs || {};
    state.prog = state.prog || { words: 0, gram: 0, read: 0, listen: 0, write: 0, speak: 0 };
    return state;
  }

  function loadLocal(username) {
    try { return normalize(JSON.parse(global.localStorage.getItem(dataKey(username)))); }
    catch (_) { return normalize({}); }
  }

  function saveLocal(username, state) {
    if (!username) return false;
    try {
      global.localStorage.setItem(dataKey(username), JSON.stringify(state));
      return true;
    } catch (_) {
      return false;
    }
  }

  // Modules still waiting in the sync queue are newer than anything the server returned.
  function applyModules(state, modules) {
    const target = normalize(state);
    Object.keys(modules || {}).forEach((key) => {
      if (modules[key] !== undefined) target[key] = modules[key];
    });
    return target;
  }

  // Server answer first, the local snapshot when the network is gone, defaults only for a new device.
  function restore(username, serverState, pendingModules) {
    const base = serverState ? normalize(serverState) : loadLocal(username);
    return applyModules(base, pendingModules);
  }

  global.EasyBoostStore = Object.freeze({
    normalize,
    loadLocal,
    saveLocal,
    applyModules,
    restore,
    sync,
  });
})(window);
