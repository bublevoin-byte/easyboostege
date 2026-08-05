const STORAGE_KEY = 'easyboost.adaptive.overview.v1';
const STORAGE_VERSION = 'adaptive-overview-cache-v1';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_SNAPSHOT_CHARS = 120_000;
const PUBLIC_FIELDS = Object.freeze(['goal', 'profile', 'plan', 'retention', 'access']);

function validOwner(owner) {
  return typeof owner === 'string' && owner.length >= 1 && owner.length <= 64
    && !/[\u0000-\u001f\u007f]/u.test(owner);
}

function publicProjection(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (PUBLIC_FIELDS.some((field) => !Object.prototype.hasOwnProperty.call(payload, field))) return null;
  if (!payload.access || typeof payload.access !== 'object' || Array.isArray(payload.access)
    || !payload.retention || typeof payload.retention !== 'object' || Array.isArray(payload.retention)) return null;
  const projection = {};
  for (const field of PUBLIC_FIELDS) projection[field] = payload[field] ?? null;
  return projection;
}

function remove(storage) {
  try { storage?.removeItem(STORAGE_KEY); } catch { /* best-effort local cache */ }
}

export function writeAdaptiveOverviewCache(storage, owner, payload, now = Date.now()) {
  if (!validOwner(owner) || !Number.isFinite(Number(now))) {
    remove(storage);
    return false;
  }
  try {
    const projected = publicProjection(payload);
    if (!projected) throw new Error('ADAPTIVE_OVERVIEW_CACHE_INVALID');
    const serialized = JSON.stringify({
      version: STORAGE_VERSION,
      owner,
      savedAt: Number(now),
      payload: projected,
    });
    if (serialized.length > MAX_SNAPSHOT_CHARS) throw new Error('ADAPTIVE_OVERVIEW_CACHE_TOO_LARGE');
    storage.setItem(STORAGE_KEY, serialized);
    return true;
  } catch {
    return false;
  }
}

export function readAdaptiveOverviewCacheSnapshot(storage, owner, now = Date.now()) {
  try {
    if (!validOwner(owner) || !Number.isFinite(Number(now))) throw new Error('ADAPTIVE_OVERVIEW_CACHE_INVALID');
    const raw = storage?.getItem(STORAGE_KEY);
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_SNAPSHOT_CHARS) {
      throw new Error('ADAPTIVE_OVERVIEW_CACHE_INVALID');
    }
    const value = JSON.parse(raw);
    const age = Number(now) - Number(value?.savedAt);
    if (value?.version !== STORAGE_VERSION || value.owner !== owner
      || !Number.isFinite(age) || age < -60_000 || age >= MAX_AGE_MS) {
      throw new Error('ADAPTIVE_OVERVIEW_CACHE_INVALID');
    }
    const projected = publicProjection(value.payload);
    if (!projected) throw new Error('ADAPTIVE_OVERVIEW_CACHE_INVALID');
    return { savedAt: Number(value.savedAt), payload: projected };
  } catch {
    remove(storage);
    return null;
  }
}

export function readAdaptiveOverviewCache(storage, owner, now = Date.now()) {
  return readAdaptiveOverviewCacheSnapshot(storage, owner, now)?.payload || null;
}

export function clearAdaptiveOverviewCache(storage) {
  remove(storage);
}

export const ADAPTIVE_OVERVIEW_CACHE_MAX_AGE_MS = MAX_AGE_MS;
