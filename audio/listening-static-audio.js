import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertListeningCatalog } from '../public/listening-catalog-contract.js';
import {
  assertListeningAudioManifest,
  EMPTY_LISTENING_AUDIO_MANIFEST,
  isSafeListeningAudioAssetPath,
  LISTENING_AUDIO_CATALOG_ID,
  LISTENING_AUDIO_CATALOG_REVISION,
  LISTENING_AUDIO_MAX_MP3_BYTES,
  LISTENING_AUDIO_MANIFEST_SCHEMA_VERSION,
  LISTENING_AUDIO_MIN_MP3_BYTES,
  LISTENING_AUDIO_SAFE_ASSET_PATH,
  LISTENING_AUDIO_TYPE_DIRECTORIES,
  LISTENING_AUDIO_VOICE_IDS,
} from '../public/listening-audio-contract.js';

const CATALOG_ID = LISTENING_AUDIO_CATALOG_ID;
const MANIFEST_SCHEMA_VERSION = LISTENING_AUDIO_MANIFEST_SCHEMA_VERSION;
const DEFAULT_PRICE_USD_PER_MILLION = 15;
const MIN_MP3_BYTES = LISTENING_AUDIO_MIN_MP3_BYTES;
const MAX_MP3_BYTES = LISTENING_AUDIO_MAX_MP3_BYTES;
const PAID_CONFIRMATION = 'I_ACCEPT_XAI_TTS_CHARGES';
const SAFE_ASSET_PATH = LISTENING_AUDIO_SAFE_ASSET_PATH;
const TYPE_DIRECTORY = LISTENING_AUDIO_TYPE_DIRECTORIES;
const VOICE_IDS = LISTENING_AUDIO_VOICE_IDS;

export const LISTENING_AUDIO_DEFAULT_PRICE_USD_PER_MILLION = DEFAULT_PRICE_USD_PER_MILLION;
export const LISTENING_AUDIO_PAID_CONFIRMATION = PAID_CONFIRMATION;
export { EMPTY_LISTENING_AUDIO_MANIFEST };

function checksum(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function normalizedMimeType(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function mp3SignatureIsValid(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < MIN_MP3_BYTES || bytes.length > MAX_MP3_BYTES) return false;
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3') return true;
  return bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
}

function normalizePrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0 || price > 10_000) {
    throw new TypeError('priceUsdPerMillion must be between 0 and 10000');
  }
  return price;
}

function slugForSet(set) {
  const prefix = `${CATALOG_ID}.${set.type === 'true_false' ? 'true-false' : set.type}.`;
  if (!set.id.startsWith(prefix)) throw new TypeError(`${set.id}: id does not match its listening type`);
  return set.id.slice(prefix.length);
}

function plannedPath(set, segment, segmentIndex) {
  const directory = TYPE_DIRECTORY[set.type];
  const slug = slugForSet(set);
  const role = segment.role.replaceAll('_', '-');
  const voiceSlot = segment.voiceSlot.replaceAll('_', '-');
  const assetPath = `/audio/listening/${CATALOG_ID}/${directory}/${slug}-r${set.revision}-s${String(segmentIndex + 1).padStart(2, '0')}-${role}-${voiceSlot}.mp3`;
  if (!SAFE_ASSET_PATH.test(assetPath) || assetPath.includes('..')) {
    throw new TypeError(`${set.id}.script[${segmentIndex}]: unsafe static audio path`);
  }
  return assetPath;
}

export function buildListeningAudioPlan(catalog, {
  priceUsdPerMillion = DEFAULT_PRICE_USD_PER_MILLION,
} = {}) {
  assertListeningCatalog(catalog, {
    expectedCounts: { matching: 20, true_false: 20, interview: 20 },
    minimumTopics: 20,
  });
  const price = normalizePrice(priceUsdPerMillion);
  const jobs = catalog.sets.flatMap((set) => set.script.map((segment, segmentIndex) => ({
    id: `${set.id}@r${set.revision}:s${String(segmentIndex + 1).padStart(2, '0')}`,
    setId: set.id,
    revision: set.revision,
    type: set.type,
    segmentIndex,
    role: segment.role,
    voiceSlot: segment.voiceSlot,
    providerVoice: VOICE_IDS[segment.voiceSlot],
    text: segment.text,
    characterCount: Array.from(segment.text).length,
    path: plannedPath(set, segment, segmentIndex),
  })));
  const characterCount = jobs.reduce((total, job) => total + job.characterCount, 0);
  return Object.freeze({
    catalogId: catalog.id,
    catalogRevision: catalog.revision,
    setCount: catalog.sets.length,
    jobs: Object.freeze(jobs),
    assetCount: jobs.length,
    characterCount,
    priceUsdPerMillion: price,
    estimatedUsd: Number(((characterCount * price) / 1_000_000).toFixed(6)),
  });
}

function validateManifestShape(value) {
  return assertListeningAudioManifest(value);
}

function assertManifestMatchesPlan(manifest, plan) {
  const jobsByPath = new Map(plan.jobs.map((job) => [job.path, job]));
  manifest.assets.forEach((asset, index) => {
    const job = jobsByPath.get(asset.path);
    if (!job || ['setId', 'revision', 'type', 'segmentIndex', 'role', 'voiceSlot', 'providerVoice']
      .some((field) => asset[field] !== job[field])) {
      throw new TypeError(`manifest.assets[${index}] does not match the catalog plan`);
    }
  });
}

async function readManifest(manifestPath) {
  try {
    return validateManifestShape(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return EMPTY_LISTENING_AUDIO_MANIFEST;
    throw error;
  }
}

function absoluteAssetPath(publicDirectory, browserPath) {
  if (!isSafeListeningAudioAssetPath(browserPath)) throw new TypeError('Unsafe listening audio asset path');
  const root = path.resolve(publicDirectory);
  const absolute = path.resolve(root, browserPath.slice(1).replaceAll('/', path.sep));
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new TypeError('Listening audio asset escaped public directory');
  return absolute;
}

async function inspectExisting(job, publicDirectory, manifestAsset) {
  const outputPath = absoluteAssetPath(publicDirectory, job.path);
  try {
    const bytes = await fs.readFile(outputPath);
    if (!mp3SignatureIsValid(bytes)) return null;
    const sha256 = checksum(bytes);
    if (manifestAsset && (manifestAsset.sha256 !== sha256 || manifestAsset.bytes !== bytes.length)) return null;
    return { bytes: bytes.length, sha256, outputPath };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function manifestAssetFor(job, details) {
  return {
    setId: job.setId,
    revision: job.revision,
    type: job.type,
    segmentIndex: job.segmentIndex,
    role: job.role,
    voiceSlot: job.voiceSlot,
    providerVoice: job.providerVoice,
    path: job.path,
    mimeType: 'audio/mpeg',
    bytes: details.bytes,
    sha256: details.sha256,
  };
}

async function writeFileAtomically(targetPath, bytes) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.writeFile(temporaryPath, bytes, { flag: 'wx' });
    await fs.rename(temporaryPath, targetPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function writeManifestAtomically(manifestPath, manifest) {
  const serializable = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    catalogId: CATALOG_ID,
    catalogRevision: LISTENING_AUDIO_CATALOG_REVISION,
    assets: manifest.assets.slice().sort((left, right) => left.path.localeCompare(right.path, 'en')),
  };
  await writeFileAtomically(manifestPath, Buffer.from(`${JSON.stringify(serializable, null, 2)}\n`));
}

function validatedProviderResponse(response, job) {
  if (!response || typeof response !== 'object') throw new TypeError(`${job.id}: TTS provider returned no response`);
  if (normalizedMimeType(response.mimeType) !== 'audio/mpeg') {
    throw new TypeError(`${job.id}: TTS provider response must be audio/mpeg`);
  }
  const bytes = Buffer.isBuffer(response.bytes) ? response.bytes : Buffer.from(response.bytes || []);
  if (!mp3SignatureIsValid(bytes)) throw new TypeError(`${job.id}: TTS provider returned an invalid MP3 payload`);
  return { bytes, sha256: checksum(bytes) };
}

export async function runListeningAudioPipeline({
  catalog,
  publicDirectory,
  manifestPath,
  mode = 'dry-run',
  priceUsdPerMillion = DEFAULT_PRICE_USD_PER_MILLION,
  paidConfirmed = false,
  apiKey = '',
  provider,
} = {}) {
  if (mode !== 'dry-run' && mode !== 'generate') throw new TypeError('mode must be dry-run or generate');
  const plan = buildListeningAudioPlan(catalog, { priceUsdPerMillion });
  const manifest = await readManifest(manifestPath);
  assertManifestMatchesPlan(manifest, plan);
  const manifestByPath = new Map(manifest.assets.map((asset) => [asset.path, asset]));
  const existingByPath = new Map();
  for (const job of plan.jobs) {
    const existing = await inspectExisting(job, publicDirectory, manifestByPath.get(job.path));
    if (existing) existingByPath.set(job.path, existing);
  }
  const missing = plan.jobs.filter((job) => !existingByPath.has(job.path));
  const missingCharacterCount = missing.reduce((total, job) => total + job.characterCount, 0);
  const summary = {
    mode,
    catalogId: plan.catalogId,
    catalogRevision: plan.catalogRevision,
    setCount: plan.setCount,
    requestCount: missing.length,
    assetCount: plan.assetCount,
    characterCount: missingCharacterCount,
    totalCharacterCount: plan.characterCount,
    priceUsdPerMillion: plan.priceUsdPerMillion,
    estimatedUsd: Number(((missingCharacterCount * plan.priceUsdPerMillion) / 1_000_000).toFixed(6)),
    totalEstimatedUsd: plan.estimatedUsd,
    missing: missing.map((job) => job.path),
    missingCount: missing.length,
    generatedCount: 0,
    skippedCount: plan.assetCount - missing.length,
  };
  if (mode === 'dry-run') return summary;

  if (!paidConfirmed) throw new Error(`Generation requires explicit paid confirmation: --confirm-paid=${PAID_CONFIRMATION}`);
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Generation requires XAI_API_KEY');
  if (typeof provider !== 'function') throw new TypeError('Generation requires a TTS provider');

  const nextAssets = new Map(manifest.assets.map((asset) => [asset.path, asset]));
  for (const job of plan.jobs) {
    const existing = existingByPath.get(job.path);
    if (existing) {
      if (!nextAssets.has(job.path)) {
        nextAssets.set(job.path, manifestAssetFor(job, existing));
        await writeManifestAtomically(manifestPath, { assets: Array.from(nextAssets.values()) });
      }
      continue;
    }
    const response = validatedProviderResponse(await provider(job), job);
    const outputPath = absoluteAssetPath(publicDirectory, job.path);
    await writeFileAtomically(outputPath, response.bytes);
    const published = await inspectExisting(job, publicDirectory, null);
    if (!published || published.sha256 !== response.sha256) {
      await fs.rm(outputPath, { force: true });
      throw new Error(`${job.id}: published MP3 failed checksum validation`);
    }
    nextAssets.set(job.path, manifestAssetFor(job, published));
    await writeManifestAtomically(manifestPath, { assets: Array.from(nextAssets.values()) });
    summary.generatedCount += 1;
  }
  summary.skippedCount = plan.assetCount - summary.generatedCount;
  summary.missing = [];
  summary.missingCount = 0;
  return summary;
}

export function createXaiTtsProvider({
  apiKey,
  fetchImpl = globalThis.fetch,
  endpoint = 'https://api.x.ai/v1/tts',
} = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('XAI_API_KEY is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');
  return async function xaiTtsProvider(job) {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: job.text,
        voice_id: job.providerVoice,
        language: 'en',
        output_format: { codec: 'mp3', sample_rate: 24_000, bit_rate: 128_000 },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`xAI TTS request failed with HTTP ${response.status}`);
    return {
      mimeType: response.headers.get('content-type'),
      bytes: Buffer.from(await response.arrayBuffer()),
    };
  };
}
