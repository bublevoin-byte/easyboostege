const CACHE_PREFIX = 'easyboost-ege-mock-assets-v1-';

function writtenAssetIds(form) {
  return [...new Set((form?.positions || []).slice(0, 36).flatMap((position) => position.assetIds || []))];
}

function egeMockWrittenAssetManifest(form) {
  const ids = writtenAssetIds(form);
  const byId = new Map((form?.assets || []).map((asset) => [asset.id, asset]));
  const assets = ids.map((id) => byId.get(id));
  if (assets.length !== 20 || assets.some((asset) => !asset || asset.kind !== 'audio'
    || asset.mimeType !== 'audio/mpeg' || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0
    || !/^[a-f0-9]{64}$/u.test(asset.sha256) || asset.path !== asset.id)) {
    throw new TypeError('EGE_MOCK_WRITTEN_ASSET_MANIFEST_INVALID');
  }
  return assets;
}

function egeMockAssetCacheName(form) {
  const identity = String(form?.identity || '').replace(/[^a-z0-9@._-]/giu, '_');
  const match = /^sha256:([a-f0-9]{64})$/u.exec(String(form?.fingerprint || ''));
  const fingerprint = match?.[1] || '';
  if (!identity || !fingerprint) throw new TypeError('EGE_MOCK_WRITTEN_ASSET_IDENTITY_INVALID');
  return `${CACHE_PREFIX}${identity}-${fingerprint}`;
}

function egeMockExactAssetUrl(form, assetPath, assetDigest) {
  if (typeof assetPath !== 'string' || !assetPath.startsWith('/')
    || !/^[a-f0-9]{64}$/u.test(String(assetDigest || ''))) {
    throw new TypeError('EGE_MOCK_ASSET_BINDING_INVALID');
  }
  const parameters = new URLSearchParams({
    egeMockAssetCache: egeMockAssetCacheName(form), egeMockAssetDigest: assetDigest,
  });
  return `${assetPath}?${parameters}`;
}

function egeMockAssetPlaybackUrl(form, assetPath) {
  const asset = egeMockWrittenAssetManifest(form).find((candidate) => candidate.path === assetPath);
  if (!asset) throw new TypeError('EGE_MOCK_WRITTEN_ASSET_PATH_INVALID');
  return egeMockExactAssetUrl(form, assetPath, asset.sha256);
}

async function sha256(bytes) {
  const result = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(result)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function controllingServiceWorkerSupportsExactAssets(serviceWorker, MessageChannelConstructor) {
  const controller = serviceWorker?.controller;
  if (!controller || typeof controller.postMessage !== 'function'
    || typeof MessageChannelConstructor !== 'function') return false;
  return new Promise((resolve) => {
    const channel = new MessageChannelConstructor();
    const timer = setTimeout(() => resolve(false), 1_500);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event?.data?.capability === 'easyboost-ege-mock-assets-v1');
    };
    try { controller.postMessage({ type: 'EGE_MOCK_ASSET_CAPABILITY' }, [channel.port2]); }
    catch (_) { clearTimeout(timer); resolve(false); }
  });
}

function createEgeMockAssetPreflight(options = {}) {
  const fetcher = options.fetch || globalThis.fetch?.bind(globalThis);
  const cacheStorage = options.cacheStorage || globalThis.caches;
  const digest = options.digest || sha256;
  const lockManager = options.lockManager || globalThis.navigator?.locks;
  const playbackControl = options.playbackControl || (() => controllingServiceWorkerSupportsExactAssets(
    options.serviceWorker || globalThis.navigator?.serviceWorker, options.MessageChannel || globalThis.MessageChannel,
  ));
  if (typeof fetcher !== 'function' || !cacheStorage || typeof cacheStorage.open !== 'function') {
    throw new TypeError('EGE_MOCK_WRITTEN_ASSET_DEPENDENCY_MISSING');
  }

  function evidenceFor(form, manifest) {
    return Object.freeze({
      schema: 'ege-mock-written-assets-v1', identity: form.identity,
      fingerprint: form.fingerprint, assetCount: manifest.length,
    });
  }

  async function cacheReady(form, manifest) {
    const cache = await cacheStorage.open(egeMockAssetCacheName(form));
    try {
      for (const asset of manifest) {
        const response = await cache.match(egeMockAssetPlaybackUrl(form, asset.path));
        if (!response) return false;
        await verifyResponse(response, asset);
      }
      return true;
    } catch (_) { return false; }
  }

  async function verifyResponse(response, asset) {
    if (!response?.ok || response.status !== 200) throw Object.assign(new Error('EGE_MOCK_ASSET_FETCH_FAILED'), {
      code: 'EGE_MOCK_ASSET_FETCH_FAILED', assetId: asset.id,
    });
    const contentType = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
    if (contentType !== asset.mimeType) throw Object.assign(new Error('EGE_MOCK_ASSET_MIME_MISMATCH'), {
      code: 'EGE_MOCK_ASSET_MIME_MISMATCH', assetId: asset.id,
    });
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== asset.bytes || await digest(bytes, asset) !== asset.sha256) {
      throw Object.assign(new Error('EGE_MOCK_ASSET_DIGEST_MISMATCH'), {
        code: 'EGE_MOCK_ASSET_DIGEST_MISMATCH', assetId: asset.id,
      });
    }
  }

  async function preflight(form) {
    const manifest = egeMockWrittenAssetManifest(form);
    const name = egeMockAssetCacheName(form);
    if (!await playbackControl()) throw new Error('EGE_MOCK_SERVICE_WORKER_REQUIRED');
    if (!lockManager || typeof lockManager.request !== 'function') {
      throw new Error('EGE_MOCK_ASSET_LOCK_REQUIRED');
    }
    return lockManager.request(`easyboost-ege-mock-preflight:${name}`, async () => {
      const evidence = evidenceFor(form, manifest);
      if (await cacheReady(form, manifest)) return evidence;
      await cacheStorage.delete?.(name);
      const cache = await cacheStorage.open(name);
      try {
        for (const asset of manifest) {
          const response = await fetcher(asset.path, { cache: 'no-store', credentials: 'same-origin' });
          const cacheCopy = response.clone();
          await verifyResponse(response, asset);
          await cache.put(egeMockAssetPlaybackUrl(form, asset.path), cacheCopy);
        }
      } catch (error) {
        await cacheStorage.delete?.(name);
        throw error;
      }
      return evidence;
    });
  }

  async function isReady(form, evidence) {
    const manifest = egeMockWrittenAssetManifest(form);
    if (evidence?.schema !== 'ege-mock-written-assets-v1' || evidence.identity !== form.identity
      || evidence.fingerprint !== form.fingerprint || evidence.assetCount !== manifest.length) return false;
    return Boolean(await playbackControl()) && cacheReady(form, manifest);
  }

  return Object.freeze({ isReady, preflight });
}

export {
  CACHE_PREFIX, controllingServiceWorkerSupportsExactAssets, createEgeMockAssetPreflight,
  egeMockAssetCacheName, egeMockAssetPlaybackUrl, egeMockExactAssetUrl,
  egeMockWrittenAssetManifest,
};
