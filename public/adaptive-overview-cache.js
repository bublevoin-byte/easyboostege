const STORAGE_KEY = 'easyboost.adaptive.overview.v1';
const STORAGE_VERSION = 'adaptive-overview-cache-v3';
const LEGACY_STORAGE_VERSIONS = Object.freeze(['adaptive-overview-cache-v2', 'adaptive-overview-cache-v1']);
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_SNAPSHOT_CHARS = 120_000;
const PUBLIC_FIELDS = Object.freeze(['goal', 'profile', 'plan', 'retention', 'access', 'grammarRecommendation']);

function storageKey(owner, ownerGeneration) {
  return `${STORAGE_KEY}:${encodeURIComponent(owner)}:g${ownerGeneration}`;
}

function validOwner(owner) {
  return typeof owner === 'string' && owner.length >= 1 && owner.length <= 64
    && !/[\u0000-\u001f\u007f]/u.test(owner);
}

function publicProjection(payload, { legacy = false } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (PUBLIC_FIELDS.some((field) => !Object.prototype.hasOwnProperty.call(payload, field)
    && !(legacy && field === 'grammarRecommendation'))) return null;
  if (!payload.access || typeof payload.access !== 'object' || Array.isArray(payload.access)
    || !payload.retention || typeof payload.retention !== 'object' || Array.isArray(payload.retention)) return null;
  const projection = {};
  for (const field of PUBLIC_FIELDS) projection[field] = payload[field] ?? null;
  return projection;
}

export async function writeAdaptiveOverviewCache(storage, owner, payload, now = Date.now(), ownerGeneration = 0) {
  if (!validOwner(owner) || !Number.isFinite(Number(now))
    || !Number.isSafeInteger(ownerGeneration) || ownerGeneration < 0) {
    return false;
  }
  const incarnation = window.EasyBoostOwnerIncarnation;
  if (!incarnation || typeof incarnation.withOwnerLock !== 'function'
    || typeof incarnation.snapshot !== 'function') return false;
  const saved = await incarnation.withOwnerLock(owner, () => {
    try {
      const before = incarnation.snapshot(owner);
      if (before.deleted || before.ownerGeneration !== ownerGeneration) return false;
      const projected = publicProjection(payload);
      if (!projected) throw new Error('ADAPTIVE_OVERVIEW_CACHE_INVALID');
      const serialized = JSON.stringify({
        version: STORAGE_VERSION,
        owner, ownerGeneration,
        savedAt: Number(now),
        payload: projected,
      });
      if (serialized.length > MAX_SNAPSHOT_CHARS) throw new Error('ADAPTIVE_OVERVIEW_CACHE_TOO_LARGE');
      const key = storageKey(owner, ownerGeneration); storage.setItem(key, serialized);
      const after = incarnation.snapshot(owner);
      if (after.deleted || after.ownerGeneration !== ownerGeneration) {
        if (storage.getItem(key) === serialized) storage.removeItem(key);
        return false;
      }
      return storage.getItem(key) === serialized;
    } catch {
      return false;
    }
  });
  return saved === true;
}

export function readAdaptiveOverviewCacheSnapshot(storage, owner, now = Date.now(), ownerGeneration = 0) {
  try {
    if (!validOwner(owner) || !Number.isFinite(Number(now))
      || !Number.isSafeInteger(ownerGeneration) || ownerGeneration < 0) throw new Error('ADAPTIVE_OVERVIEW_CACHE_INVALID');
    const raw = storage?.getItem(storageKey(owner, ownerGeneration))
      ?? (ownerGeneration === 0 ? storage?.getItem(STORAGE_KEY) : null);
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_SNAPSHOT_CHARS) {
      return null;
    }
    const value = JSON.parse(raw);
    const age = Number(now) - Number(value?.savedAt);
    const legacy = LEGACY_STORAGE_VERSIONS.includes(value?.version);
    const generation = value?.version === 'adaptive-overview-cache-v1' ? 0 : value?.ownerGeneration;
    if (![STORAGE_VERSION, ...LEGACY_STORAGE_VERSIONS].includes(value?.version)
      || value.owner !== owner || generation !== ownerGeneration) return null;
    if (!Number.isFinite(age) || age < -60_000 || age >= MAX_AGE_MS) return null;
    const projected = publicProjection(value.payload, { legacy });
    if (!projected) throw new Error('ADAPTIVE_OVERVIEW_CACHE_INVALID');
    return { savedAt: Number(value.savedAt), payload: projected };
  } catch {
    return null;
  }
}

export function readAdaptiveOverviewCache(storage, owner, now = Date.now(), ownerGeneration = 0) {
  return readAdaptiveOverviewCacheSnapshot(storage, owner, now, ownerGeneration)?.payload || null;
}

export function clearAdaptiveOverviewCache(storage, authority = null) {
  try {
    if (!authority) {
      storage?.removeItem(STORAGE_KEY);
      return true;
    }
    const targetKey = storageKey(authority.owner, authority.ownerGeneration);
    const raw = storage?.getItem(targetKey)
      ?? (authority.ownerGeneration === 0 ? storage?.getItem(STORAGE_KEY) : null);
    if (!raw) return true;
    const value = JSON.parse(raw); const generation = value?.version === 'adaptive-overview-cache-v1' ? 0 : value?.ownerGeneration;
    const expected = authority;
    if (!validOwner(expected.owner) || !Number.isSafeInteger(expected.ownerGeneration)) return false;
    const key = storage?.getItem(targetKey) ? targetKey : STORAGE_KEY;
    return window.EasyBoostOwnerIncarnation.clearMatchingStorage(expected.owner, key, (candidate) => {
      try {
        const stored = JSON.parse(candidate);
      const storedGeneration = stored?.version === 'adaptive-overview-cache-v1' ? 0 : stored?.ownerGeneration;
        return stored?.owner === expected.owner && storedGeneration === expected.ownerGeneration;
      } catch { return false; }
    }, null, storage);
  } catch { return Promise.resolve(false); }
}

export const ADAPTIVE_OVERVIEW_CACHE_MAX_AGE_MS = MAX_AGE_MS;
