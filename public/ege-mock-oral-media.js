import { createSpeakingLocalRecorder } from './speaking-local-recording.js';
import { convertRecordingToPcm16Wav } from './speaking-pronunciation-audio.js';
import { egeMockAssetCacheName, egeMockExactAssetUrl } from './ege-mock-written-assets.js';

const DATABASE_NAME = 'easyboost-ege-mock-oral-media-v1';
const STORE_NAME = 'recordings';

function bindingKey(binding) {
  return [
    binding.username, binding.ownerGeneration, binding.attemptId, binding.formId, binding.formRevision,
    binding.catalogFingerprint, binding.position, binding.responseNumber, binding.recordingId,
    binding.sha256,
  ].join('\u0000');
}

function openDatabase(indexedDB) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('EGE_MOCK_ORAL_MEDIA_DB_FAILED'));
  });
}

async function transact(indexedDB, mode, run) {
  const database = await openDatabase(indexedDB);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      let result;
      try { result = run(store); } catch (error) { reject(error); return; }
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error || new Error('EGE_MOCK_ORAL_MEDIA_DB_FAILED'));
      transaction.onabort = () => reject(transaction.error || new Error('EGE_MOCK_ORAL_MEDIA_DB_ABORTED'));
    });
  } finally { database.close(); }
}

async function sha256(blob, crypto) {
  if (!crypto?.subtle) throw new Error('EGE_MOCK_ORAL_CRYPTO_UNAVAILABLE');
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0')).join('');
}

function preloadImage(src, Image) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = async () => {
      try { if (typeof image.decode === 'function') await image.decode(); resolve(true); }
      catch { reject(new Error('EGE_MOCK_ORAL_ASSET_INVALID')); }
    };
    image.onerror = () => reject(new Error('EGE_MOCK_ORAL_ASSET_UNAVAILABLE'));
    image.src = src;
  });
}

export function createEgeMockOralMedia(options = {}) {
  const indexedDB = options.indexedDB || globalThis.indexedDB;
  const crypto = options.crypto || globalThis.crypto;
  const Image = options.Image || globalThis.Image;
  const Audio = options.Audio || globalThis.Audio;
  const urlApi = options.URL || globalThis.URL;
  const fetchAsset = options.fetch || globalThis.fetch;
  const cacheStorage = options.cacheStorage || globalThis.caches;
  const lockManager = options.lockManager || globalThis.navigator?.locks;
  const convertRecording = options.convertRecording || convertRecordingToPcm16Wav;
  const createRecorder = options.createRecorder || createSpeakingLocalRecorder;
  if (!indexedDB) throw new TypeError('EGE_MOCK_ORAL_INDEXED_DB_REQUIRED');
  let latestRawRecording = null;
  let resolveRawRecording = null;
  let rawRecordingReady = null;
  let acceptRecordingReady = false;
  let verifiedAssets = new Map();
  let recordingLeaseName = '';
  let recordingLeaseHeld = false;
  let recordingLeaseRelease = null;
  let recordingLeaseRequest = null;
  const recorder = createRecorder({
    ...options,
    onRecordingReady(recording) {
      if (!acceptRecordingReady) return;
      latestRawRecording = recording;
      resolveRawRecording?.(recording);
      options.onRecordingReady?.(recording);
    },
  });

  async function verifiedImageBlob(response, asset) {
    if (!response?.ok || response.status !== 200 || typeof response.arrayBuffer !== 'function') {
      throw new Error('EGE_MOCK_ORAL_ASSET_UNAVAILABLE');
    }
    const contentType = String(response?.headers?.get?.('content-type') || '')
      .split(';', 1)[0].trim().toLowerCase();
    let bytes;
    try { bytes = await response.arrayBuffer(); }
    catch { throw new Error('EGE_MOCK_ORAL_ASSET_UNAVAILABLE'); }
    const blob = new Blob([bytes], { type: asset.mimeType });
    if (contentType !== asset.mimeType || await sha256(blob, crypto) !== asset.sha256) {
      throw new Error('EGE_MOCK_ORAL_ASSET_INVALID');
    }
    return blob;
  }

  async function exactImageBlob(form, src, asset) {
    const cache = await cacheStorage.open(egeMockAssetCacheName(form));
    const exactUrl = egeMockExactAssetUrl(form, src, asset.sha256);
    const cached = await cache.match(exactUrl);
    if (cached) {
      try { return await verifiedImageBlob(cached, asset); }
      catch (_) { await cache.delete?.(exactUrl); }
    }
    let response;
    try { response = await fetchAsset(src, { cache: 'no-store', credentials: 'same-origin' }); }
    catch { throw new Error('EGE_MOCK_ORAL_ASSET_UNAVAILABLE'); }
    if (!response?.ok || response.status !== 200 || typeof response.clone !== 'function') {
      throw new Error('EGE_MOCK_ORAL_ASSET_UNAVAILABLE');
    }
    const cacheCopy = response.clone();
    const blob = await verifiedImageBlob(response, asset);
    await cache.put(exactUrl, cacheCopy);
    return blob;
  }

  async function preflight({ form, tasks, assets = [] }) {
    const microphone = await recorder.checkMicrophone();
    if (!['passed', 'quiet'].includes(microphone.status)) {
      throw new Error('EGE_MOCK_ORAL_MICROPHONE_REQUIRED');
    }
    const images = [...new Set(tasks.flatMap(({ presentation }) => {
      const pair = presentation?.photoPair;
      return pair ? [pair.src, pair.left?.src, pair.right?.src].filter(Boolean) : [];
    }))];
    const manifest = new Map(assets.map((asset) => [asset.path || asset.url || asset.id, asset]));
    if (images.length && (typeof Image !== 'function' || typeof urlApi?.createObjectURL !== 'function'
      || typeof urlApi?.revokeObjectURL !== 'function')) throw new Error('EGE_MOCK_ORAL_ASSET_UNAVAILABLE');
    if (images.length && (!cacheStorage || typeof cacheStorage.open !== 'function'
      || !lockManager || typeof lockManager.request !== 'function')) {
      throw new Error('EGE_MOCK_ORAL_ASSET_CACHE_REQUIRED');
    }
    const nextAssets = new Map();
    try {
      await lockManager?.request(
        `easyboost-ege-mock-oral-assets:${images.length ? egeMockAssetCacheName(form) : 'none'}`,
        async () => {
          for (const src of images) {
            const asset = manifest.get(src);
            if (!asset || asset.kind !== 'image' || asset.mimeType !== 'image/png'
              || !/^[a-f0-9]{64}$/u.test(asset.sha256 || '') || typeof fetchAsset !== 'function') {
              throw new Error('EGE_MOCK_ORAL_ASSET_INVALID');
            }
            const blob = await exactImageBlob(form, src, asset);
            const verifiedUrl = urlApi.createObjectURL(blob);
            nextAssets.set(src, verifiedUrl);
            await preloadImage(verifiedUrl, Image);
          }
        }
      );
    } catch (error) {
      nextAssets.forEach((url) => urlApi.revokeObjectURL(url));
      throw error;
    }
    verifiedAssets.forEach((url) => urlApi.revokeObjectURL(url));
    verifiedAssets = nextAssets;
    return { microphone, assetCount: images.length };
  }

  function assetUrl(src) {
    const url = verifiedAssets.get(src);
    if (!url) throw new Error('EGE_MOCK_ORAL_ASSET_UNAVAILABLE');
    return url;
  }

  async function put(binding, blob) {
    if (!(blob instanceof Blob) || binding.sha256 !== await sha256(blob, crypto)) {
      throw new Error('EGE_MOCK_ORAL_RECORDING_DIGEST_MISMATCH');
    }
    await transact(indexedDB, 'readwrite', (store) => store.put({
      key: bindingKey(binding), binding: structuredClone(binding), blob,
    }));
    return true;
  }

  async function recordFor(binding) {
    const key = bindingKey(binding);
    return transact(indexedDB, 'readonly', (store) => {
      const request = store.get(key);
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    });
  }

  async function has(binding) { return Boolean(await recordFor(binding)); }
  async function get(binding) { return (await recordFor(binding))?.blob || null; }
  async function remove(binding) {
    await transact(indexedDB, 'readwrite', (store) => store.delete(bindingKey(binding)));
    return true;
  }

  async function startRecording(maximumSeconds) {
    latestRawRecording = null;
    acceptRecordingReady = true;
    rawRecordingReady = new Promise((resolve) => { resolveRawRecording = resolve; });
    try { await recorder.start(maximumSeconds); }
    catch (error) {
      acceptRecordingReady = false;
      rawRecordingReady = null;
      resolveRawRecording = null;
      throw error;
    }
  }
  async function stopRecording() {
    let raw = latestRawRecording;
    if (!raw) {
      try { raw = await recorder.stop(); }
      catch (error) {
        if (error?.code !== 'RECORDING_NOT_ACTIVE' || !rawRecordingReady) throw error;
        raw = await rawRecordingReady;
      }
    }
    latestRawRecording = null;
    acceptRecordingReady = false;
    rawRecordingReady = null;
    resolveRawRecording = null;
    const wav = await convertRecording(raw.blob);
    return {
      blob: wav.blob, durationSeconds: wav.durationSeconds,
      sha256: await sha256(wav.blob, crypto), recordingId: crypto.randomUUID(),
    };
  }
  async function cancelRecording() {
    acceptRecordingReady = false;
    try { await recorder.stop(); }
    catch (error) {
      if (error?.code !== 'RECORDING_NOT_ACTIVE') throw error;
    } finally {
      latestRawRecording = null;
      rawRecordingReady = null;
      resolveRawRecording = null;
    }
    return true;
  }
  async function acquireRecordingLease(name) {
    if (typeof name !== 'string' || !name || typeof lockManager?.request !== 'function') {
      throw new Error('EGE_MOCK_ORAL_RECORDING_LOCK_REQUIRED');
    }
    if (recordingLeaseHeld) return recordingLeaseName === name;
    if (recordingLeaseRequest) return false;
    let resolveAcquired;
    const acquired = new Promise((resolve) => { resolveAcquired = resolve; });
    const held = new Promise((resolve) => { recordingLeaseRelease = resolve; });
    const request = Promise.resolve(lockManager.request(
      `easyboost-ege-mock-oral-recorder:${name}`,
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => {
        if (!lock) { resolveAcquired(false); return; }
        recordingLeaseName = name;
        recordingLeaseHeld = true;
        resolveAcquired(true);
        await held;
      },
    ));
    recordingLeaseRequest = request.catch(() => { resolveAcquired(false); }).finally(() => {
      if (recordingLeaseRequest) {
        recordingLeaseName = '';
        recordingLeaseHeld = false;
        recordingLeaseRelease = null;
        recordingLeaseRequest = null;
      }
    });
    return acquired;
  }
  function hasRecordingLease() { return recordingLeaseHeld; }
  function releaseRecordingLease() {
    recordingLeaseHeld = false;
    recordingLeaseName = '';
    recordingLeaseRelease?.();
  }
  async function play(binding) {
    const blob = await get(binding);
    if (!blob || typeof Audio !== 'function') throw new Error('EGE_MOCK_ORAL_RECORDING_UNAVAILABLE');
    const url = urlApi.createObjectURL(blob);
    const audio = new Audio(url);
    try { await audio.play(); }
    finally { audio.addEventListener('ended', () => urlApi.revokeObjectURL(url), { once: true }); }
  }
  function dispose() {
    acceptRecordingReady = false;
    releaseRecordingLease();
    verifiedAssets.forEach((url) => urlApi.revokeObjectURL(url));
    verifiedAssets = new Map();
    recorder.dispose();
  }
  return Object.freeze({
    preflight, assetUrl, put, has, get, remove, startRecording, stopRecording, cancelRecording,
    acquireRecordingLease, hasRecordingLease, releaseRecordingLease, play, dispose,
  });
}
