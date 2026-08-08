(function initializeEasyBoostStore(global) {
  'use strict';

  const sync = global.EasyBoostSync;
  const incarnation = global.EasyBoostOwnerIncarnation;
  const SNAPSHOT_VERSION = 2;

  function validOwner(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 64
      && !/[\u0000-\u001f\u007f]/u.test(value);
  }

  function readCurrentOwner() {
    return incarnation?.readCurrentOwner?.() || null;
  }

  function writeCurrentOwner(owner, ownerGeneration) {
    if (!validOwner(owner) || !Number.isSafeInteger(ownerGeneration) || ownerGeneration < 0) return Promise.resolve(false);
    return incarnation.withOwnerLock(owner, (token) => incarnation.writeCurrentOwnerLocked(owner, ownerGeneration, token));
  }

  function clearCurrentOwner(owner, ownerGeneration, ownerLockToken = null) {
    if (!validOwner(owner) || !Number.isSafeInteger(ownerGeneration) || ownerGeneration < 0) return Promise.resolve(false);
    return incarnation.clearMatchingStorage(owner, 'eb_current', (raw) => {
      try {
        const value = JSON.parse(raw);
        return value?.version === 1 && value.owner === owner && value.ownerGeneration === ownerGeneration;
      } catch (_) { return ownerGeneration === 0 && raw === owner; }
    }, ownerLockToken);
  }

  function legacyDataKey(username) {
    return `eb_data_${username || 'guest'}`;
  }

  function dataKey(username, ownerGeneration) {
    return `${legacyDataKey(username)}_g${ownerGeneration}`;
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
    state.personalWords = Array.isArray(state.personalWords) ? state.personalWords : [];
    state.personalWordTombstones = Array.isArray(state.personalWordTombstones)
      ? state.personalWordTombstones : [];
    state.prog = state.prog || { words: 0, gram: 0, read: 0, listen: 0, write: 0, speak: 0 };
    return state;
  }

  function expectedOwnerGeneration(username, provided) {
    if (Number.isSafeInteger(provided) && provided >= 0) return provided;
    const bound = sync?.ownerBoundGeneration?.(username);
    if (Number.isSafeInteger(bound) && bound >= 0) return bound;
    const current = sync?.ownerAuthSnapshot?.(username)?.ownerGeneration;
    return Number.isSafeInteger(current) && current >= 0 ? current : 0;
  }

  function loadLocal(username, ownerGeneration) {
    if (sync?.isOwnerDeleted?.(username)) return normalize({});
    const expected = expectedOwnerGeneration(username, ownerGeneration);
    const authority = sync?.ownerAuthSnapshot?.(username);
    if (authority && (authority.deleted || authority.ownerGeneration !== expected)) return normalize({});
    try {
      const key = dataKey(username, expected);
      const raw = global.localStorage.getItem(key)
        ?? (expected === 0 ? global.localStorage.getItem(legacyDataKey(username)) : null);
      const parsed = JSON.parse(raw);
      const current = sync?.ownerAuthSnapshot?.(username);
      if (current && (current.deleted || current.ownerGeneration !== expected)) return normalize({});
      if (parsed && parsed.version === SNAPSHOT_VERSION && Number.isSafeInteger(parsed.ownerGeneration)) {
        if (parsed.ownerGeneration === expected) return normalize(parsed.state);
        try { global.localStorage.removeItem(key); } catch (_) {}
        return normalize({});
      }
      return expected === 0 ? normalize(parsed) : normalize({});
    }
    catch (_) { return normalize({}); }
  }

  function saveLocal(username, state, ownerGeneration) {
    if (!username || sync?.isOwnerDeleted?.(username)) return false;
    const expected = expectedOwnerGeneration(username, ownerGeneration);
    const authority = sync?.ownerAuthSnapshot?.(username);
    if (authority && (authority.deleted || authority.ownerGeneration !== expected)) return false;
    try {
      const encoded = JSON.stringify({
        version: SNAPSHOT_VERSION,
        ownerGeneration: expected,
        state,
      });
      const key = dataKey(username, expected);
      global.localStorage.setItem(key, encoded);
      const current = sync?.ownerAuthSnapshot?.(username);
      if (!current || (!current.deleted && current.ownerGeneration === expected)) return true;
      try { if (global.localStorage.getItem(key) === encoded) global.localStorage.removeItem(key); } catch (_) {}
      return false;
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
  function restore(username, serverState, pendingModules, ownerGeneration) {
    if (sync?.isOwnerDeleted?.(username)) return normalize({});
    const base = serverState ? normalize(serverState) : loadLocal(username, ownerGeneration);
    return applyModules(base, pendingModules);
  }

  global.EasyBoostStore = Object.freeze({
    normalize,
    readCurrentOwner,
    writeCurrentOwner,
    clearCurrentOwner,
    loadLocal,
    saveLocal,
    applyModules,
    restore,
    sync,
  });
})(window);
