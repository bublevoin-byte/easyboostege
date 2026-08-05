export const LISTENING_AUDIO_CATALOG_ID = 'listening-pilot-v1';
export const LISTENING_AUDIO_CATALOG_REVISION = 1;
export const LISTENING_AUDIO_MANIFEST_SCHEMA_VERSION = 1;
export const LISTENING_AUDIO_MIN_MP3_BYTES = 256;
export const LISTENING_AUDIO_MAX_MP3_BYTES = 12 * 1024 * 1024;
export const LISTENING_AUDIO_SAFE_ASSET_PATH = /^\/audio\/listening\/listening-pilot-v1\/(?:matching|true-false|interview)\/[a-z0-9]+(?:-[a-z0-9]+)*-r[1-9]\d*-s\d{2}-(?:speaker-[a-f]|interviewer|guest)-(?:female|male)-[1-3]\.mp3$/u;
export const LISTENING_AUDIO_TYPE_DIRECTORIES = Object.freeze({
  matching: 'matching',
  true_false: 'true-false',
  interview: 'interview',
});
export const LISTENING_AUDIO_VOICE_IDS = Object.freeze({
  female_1: 'ara',
  female_2: 'eve',
  female_3: 'ara',
  male_1: 'rex',
  male_2: 'leo',
  male_3: 'sal',
});

export const EMPTY_LISTENING_AUDIO_MANIFEST = Object.freeze({
  schemaVersion: LISTENING_AUDIO_MANIFEST_SCHEMA_VERSION,
  catalogId: LISTENING_AUDIO_CATALOG_ID,
  catalogRevision: LISTENING_AUDIO_CATALOG_REVISION,
  assets: Object.freeze([]),
});

export function isSafeListeningAudioAssetPath(value) {
  return typeof value === 'string'
    && !value.includes('..')
    && LISTENING_AUDIO_SAFE_ASSET_PATH.test(value);
}

export function assertListeningAudioManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Listening audio manifest must be an object');
  }
  if (value.schemaVersion !== LISTENING_AUDIO_MANIFEST_SCHEMA_VERSION) {
    throw new TypeError('Listening audio manifest schemaVersion must be 1');
  }
  if (value.catalogId !== LISTENING_AUDIO_CATALOG_ID
    || value.catalogRevision !== LISTENING_AUDIO_CATALOG_REVISION) {
    throw new TypeError('Listening audio manifest catalog identity is invalid');
  }
  if (!Array.isArray(value.assets)) throw new TypeError('Listening audio manifest assets must be an array');

  const paths = new Set();
  value.assets.forEach((asset, index) => {
    const location = `manifest.assets[${index}]`;
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
      throw new TypeError(`${location} must be an object`);
    }
    if (!isSafeListeningAudioAssetPath(asset.path)) throw new TypeError(`${location}.path is unsafe`);
    if (paths.has(asset.path)) throw new TypeError(`${location}.path is duplicated`);
    paths.add(asset.path);
    if (asset.mimeType !== 'audio/mpeg') throw new TypeError(`${location}.mimeType must be audio/mpeg`);
    if (!Number.isSafeInteger(asset.bytes)
      || asset.bytes < LISTENING_AUDIO_MIN_MP3_BYTES
      || asset.bytes > LISTENING_AUDIO_MAX_MP3_BYTES) {
      throw new TypeError(`${location}.bytes is outside the allowed MP3 size`);
    }
    if (!/^[a-f0-9]{64}$/u.test(asset.sha256 || '')) {
      throw new TypeError(`${location}.sha256 is invalid`);
    }
    if (typeof asset.setId !== 'string'
      || !Number.isSafeInteger(asset.revision)
      || !LISTENING_AUDIO_TYPE_DIRECTORIES[asset.type]
      || !Number.isSafeInteger(asset.segmentIndex)
      || asset.segmentIndex < 0
      || typeof asset.role !== 'string'
      || !LISTENING_AUDIO_VOICE_IDS[asset.voiceSlot]
      || asset.providerVoice !== LISTENING_AUDIO_VOICE_IDS[asset.voiceSlot]) {
      throw new TypeError(`${location} metadata is invalid`);
    }
  });
  return value;
}
