(function initializeOwnerIncarnation(global) {
  'use strict';

  const STORE_KEY = 'easyboost_deleted_owners_v1';
  const CURRENT_OWNER_KEY = 'eb_current';
  const CURRENT_OWNER_VERSION = 1;
  const GLOBAL_LOCK_NAME = 'easyboost-owner-incarnation:global';
  const memoryDeleted = new Set();
  const memoryOwnerGenerations = new Map();
  const activeTokens = new Map();
  let memoryGlobalGeneration = 0;

  function ownerValue(value) {
    const owner = String(value || '').trim();
    return owner && owner.length <= 64 && !/[\u0000-\u001f\u007f]/u.test(owner) ? owner : null;
  }

  function readStore() {
    try {
      const parsed = JSON.parse(global.localStorage.getItem(STORE_KEY) || 'null');
      if (!parsed || parsed.version !== 1 || !parsed.owners || typeof parsed.owners !== 'object') {
        return { version: 1, owners: {}, generations: {}, globalGeneration: 0 };
      }
      const generations = parsed.generations && typeof parsed.generations === 'object' ? parsed.generations : {};
      const normalized = {};
      Object.keys(generations).forEach((owner) => {
        const generation = Number(generations[owner]);
        if (Number.isSafeInteger(generation) && generation >= 0) normalized[owner] = generation;
      });
      Object.keys(parsed.owners).forEach((owner) => {
        if (!Number.isSafeInteger(normalized[owner])) normalized[owner] = 1;
      });
      const globalGeneration = Number(parsed.globalGeneration);
      return {
        version: 1, owners: { ...parsed.owners }, generations: normalized,
        globalGeneration: Number.isSafeInteger(globalGeneration) && globalGeneration >= 0
          ? globalGeneration : Math.max(0, ...Object.values(normalized)),
      };
    } catch (_) {
      return { version: 1, owners: {}, generations: {}, globalGeneration: 0 };
    }
  }

  function writeStore(store) {
    try {
      global.localStorage.setItem(STORE_KEY, JSON.stringify({
        version: 1, owners: store.owners || {}, generations: store.generations || {},
        globalGeneration: store.globalGeneration || 0,
      }));
      return true;
    } catch (_) { return false; }
  }

  function snapshot(owner = null) {
    const normalized = ownerValue(owner); const store = readStore();
    const durable = normalized ? Number(store.generations[normalized]) || 0 : 0;
    return {
      ownerGeneration: normalized ? Math.max(durable, memoryOwnerGenerations.get(normalized) || 0) : null,
      globalGeneration: Math.max(Number(store.globalGeneration) || 0, memoryGlobalGeneration),
      deleted: Boolean(normalized && (memoryDeleted.has(normalized) || store.owners[normalized])),
    };
  }

  function isDeleted(owner) { return Boolean(ownerValue(owner) && snapshot(owner).deleted); }

  function markDeleted(owner) {
    const normalized = ownerValue(owner); if (!normalized) return null;
    const store = readStore(); const before = snapshot(normalized);
    const ownerGeneration = Math.min(Number.MAX_SAFE_INTEGER, before.ownerGeneration + 1);
    const globalGeneration = Math.min(Number.MAX_SAFE_INTEGER, before.globalGeneration + 1);
    memoryDeleted.add(normalized); memoryOwnerGenerations.set(normalized, ownerGeneration);
    memoryGlobalGeneration = Math.max(memoryGlobalGeneration, globalGeneration);
    store.generations[normalized] = ownerGeneration; store.globalGeneration = globalGeneration;
    store.owners[normalized] = ownerGeneration;
    return { saved: writeStore(store), ownerGeneration, globalGeneration };
  }

  function observeDeleted(update) {
    const owner = ownerValue(update && update.owner); if (!owner) return false;
    const store = readStore(); const before = snapshot(owner);
    const incomingOwner = Number.isSafeInteger(Number(update.ownerGeneration))
      ? Number(update.ownerGeneration) : before.ownerGeneration + 1;
    const incomingGlobal = Number.isSafeInteger(Number(update.globalGeneration))
      ? Number(update.globalGeneration) : before.globalGeneration + 1;
    if (!store.owners[owner] && incomingOwner <= before.ownerGeneration) return false;
    const ownerGeneration = Math.max(before.ownerGeneration, incomingOwner);
    const globalGeneration = Math.max(before.globalGeneration, incomingGlobal);
    memoryDeleted.add(owner); memoryOwnerGenerations.set(owner, ownerGeneration);
    memoryGlobalGeneration = Math.max(memoryGlobalGeneration, globalGeneration);
    store.generations[owner] = ownerGeneration; store.globalGeneration = globalGeneration;
    store.owners[owner] = ownerGeneration; writeStore(store); return true;
  }

  function reviveLocked(owner) {
    const normalized = ownerValue(owner); if (!normalized) return false;
    const store = readStore(); const current = snapshot(normalized);
    store.generations[normalized] = current.ownerGeneration;
    store.globalGeneration = current.globalGeneration; delete store.owners[normalized];
    if (!writeStore(store)) return false;
    memoryDeleted.delete(normalized); memoryOwnerGenerations.set(normalized, current.ownerGeneration);
    memoryGlobalGeneration = Math.max(memoryGlobalGeneration, current.globalGeneration); return true;
  }

  function tokenMatches(token, owner) {
    const binding = activeTokens.get(token); return Boolean(binding && binding.owner === ownerValue(owner));
  }

  function withOwnerLock(owner, action, existingToken = null) {
    const normalized = ownerValue(owner); const locks = global.navigator && global.navigator.locks;
    if (!normalized || typeof action !== 'function' || !locks || typeof locks.request !== 'function') return Promise.resolve(null);
    if (existingToken && tokenMatches(existingToken, normalized)) return Promise.resolve(action(existingToken));
    return locks.request(GLOBAL_LOCK_NAME, { mode: 'exclusive' }, (globalLock) => {
      if (!globalLock) return null;
      return locks.request(`easyboost-owner-incarnation:${normalized}`, { mode: 'exclusive' }, (lock) => {
        if (!lock) return null;
        const token = Symbol('owner-incarnation-lock'); activeTokens.set(token, { owner: normalized, global: true });
        return Promise.resolve(action(token)).finally(() => { activeTokens.delete(token); });
      });
    });
  }

  function readCurrentOwner() {
    try {
      const raw = global.localStorage.getItem(CURRENT_OWNER_KEY); if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.version === CURRENT_OWNER_VERSION && ownerValue(parsed.owner) === parsed.owner
          && Number.isSafeInteger(parsed.ownerGeneration) && parsed.ownerGeneration >= 0
          && Object.keys(parsed).length === 3) return { owner: parsed.owner, ownerGeneration: parsed.ownerGeneration };
      } catch (_) { /* legacy username */ }
      const legacy = ownerValue(raw); return legacy ? { owner: legacy, ownerGeneration: 0 } : null;
    } catch (_) { return null; }
  }

  function writeCurrentOwnerLocked(owner, ownerGeneration, token) {
    if (!tokenMatches(token, owner) || !Number.isSafeInteger(ownerGeneration) || ownerGeneration < 0) return false;
    try {
      const encoded = JSON.stringify({ version: CURRENT_OWNER_VERSION, owner, ownerGeneration });
      global.localStorage.setItem(CURRENT_OWNER_KEY, encoded);
      return global.localStorage.getItem(CURRENT_OWNER_KEY) === encoded;
    } catch (_) { return false; }
  }

  function clearMatchingStorageLocked(owner, key, matcher, token, storage = global.localStorage) {
    if (!tokenMatches(token, owner) || typeof matcher !== 'function') return false;
    try {
      const raw = storage.getItem(key); if (!raw) return true;
      if (matcher(raw) !== true) return false;
      storage.removeItem(key); return true;
    } catch (_) { return false; }
  }

  function clearMatchingStorage(owner, key, matcher, existingToken = null, storage = global.localStorage) {
    return withOwnerLock(owner, (token) => clearMatchingStorageLocked(owner, key, matcher, token, storage), existingToken);
  }

  function commitOwnerAdoption(owner, guard = {}, callbacks = {}) {
    const normalized = ownerValue(owner); if (!normalized) return Promise.resolve(null);
    return withOwnerLock(normalized, (token) => {
      const current = snapshot(normalized); const ownerScoped = guard.ownerScoped !== false;
      if (ownerScoped && Number(guard.ownerGeneration) !== current.ownerGeneration) return null;
      if (!ownerScoped && Number(guard.globalGeneration) !== current.globalGeneration) return null;
      if (guard.revive === false && current.deleted) return null;
      if (typeof callbacks.canCommit === 'function' && callbacks.canCommit() !== true) return null;
      if (!writeCurrentOwnerLocked(normalized, current.ownerGeneration, token)) return null;
      if (guard.revive !== false && !reviveLocked(normalized)) {
        clearMatchingStorageLocked(normalized, CURRENT_OWNER_KEY, (raw) => {
          try { const value = JSON.parse(raw); return value.owner === normalized && value.ownerGeneration === current.ownerGeneration; } catch (_) { return false; }
        }, token);
        return null;
      }
      if (typeof callbacks.commit === 'function' && callbacks.commit(current.ownerGeneration) === false) return null;
      return { owner: normalized, ownerGeneration: current.ownerGeneration, globalGeneration: current.globalGeneration };
    });
  }

  global.EasyBoostOwnerIncarnation = Object.freeze({
    snapshot, isDeleted, markDeleted, observeDeleted, reviveLocked,
    withOwnerLock, tokenMatches, readCurrentOwner, writeCurrentOwnerLocked,
    clearMatchingStorage, clearMatchingStorageLocked, commitOwnerAdoption,
  });
})(window);
