import crypto from 'node:crypto';
import fs from 'node:fs';

const LISTENING_SET_IDS = Object.freeze([
  'listening-pilot-v1.matching.greener-life',
  'listening-pilot-v1.true-false.repair-cafe',
  'listening-pilot-v1.interview.youth-orchestra',
]);
const SPEAKING_IMAGE_PATH = '/assets/speaking/task4-v1/school-projects.png';
const PINNED_ASSET_MANIFEST_SHA256 = '66a4b8c519f70af3d0e6617af3a3db987dceee04c6fb45b4bd8d2a70968567d1';
const PINNED_SPEAKING_IMAGE = Object.freeze({
  bytes: 2471629,
  sha256: '18af3f4072fbe48946abb251abeb21f69656517f097d047d959c8ced52938507',
});

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function publicAssetBytes(browserPath) {
  return fs.readFileSync(new URL(`../public${browserPath}`, import.meta.url));
}

const listeningManifest = JSON.parse(fs.readFileSync(
  new URL('../public/audio/listening/listening-pilot-v1/manifest.json', import.meta.url),
  'utf8',
));
const selectedListening = listeningManifest.assets.filter(({ setId }) => LISTENING_SET_IDS.includes(setId));
if (selectedListening.length !== 20) throw new Error('EGE_MOCK_ASSET_MANIFEST_INCOMPLETE');

const listeningAssets = selectedListening.map((source) => {
  const bytes = publicAssetBytes(source.path);
  if (bytes.length !== source.bytes || sha256(bytes) !== source.sha256) {
    throw new Error(`EGE_MOCK_ASSET_DIGEST_MISMATCH: ${source.path}`);
  }
  return Object.freeze({
    id: source.path,
    kind: 'audio',
    path: source.path,
    mimeType: source.mimeType,
    bytes: source.bytes,
    sha256: source.sha256,
  });
});

const speakingImageBytes = publicAssetBytes(SPEAKING_IMAGE_PATH);
if (speakingImageBytes.length !== PINNED_SPEAKING_IMAGE.bytes
  || sha256(speakingImageBytes) !== PINNED_SPEAKING_IMAGE.sha256) {
  throw new Error(`EGE_MOCK_ASSET_DIGEST_MISMATCH: ${SPEAKING_IMAGE_PATH}`);
}
const speakingImage = Object.freeze({
  id: SPEAKING_IMAGE_PATH,
  kind: 'image',
  path: SPEAKING_IMAGE_PATH,
  mimeType: 'image/png',
  bytes: PINNED_SPEAKING_IMAGE.bytes,
  sha256: PINNED_SPEAKING_IMAGE.sha256,
});

export const EGE_MOCK_ASSETS = Object.freeze([...listeningAssets, speakingImage]
  .sort((left, right) => left.id.localeCompare(right.id, 'en')));
if (sha256(JSON.stringify(EGE_MOCK_ASSETS)) !== PINNED_ASSET_MANIFEST_SHA256) {
  throw new Error('EGE_MOCK_ASSET_MANIFEST_DRIFT');
}

const audioIdsBySet = new Map(LISTENING_SET_IDS.map((setId) => [
  setId,
  Object.freeze(EGE_MOCK_ASSETS.filter(({ kind, path }) => (
    kind === 'audio' && selectedListening.some((source) => source.setId === setId && source.path === path)
  )).map(({ id }) => id)),
]));

export function egeMockAssetIdsForContentRef({ id } = {}) {
  if (id === LISTENING_SET_IDS[0]) return audioIdsBySet.get(LISTENING_SET_IDS[0]);
  if (id === LISTENING_SET_IDS[1]) return audioIdsBySet.get(LISTENING_SET_IDS[1]);
  if (id?.startsWith(`${LISTENING_SET_IDS[2]}.q`)) return audioIdsBySet.get(LISTENING_SET_IDS[2]);
  if (id === 'speaking-pilot-v1.task4.school-projects') return Object.freeze([SPEAKING_IMAGE_PATH]);
  return Object.freeze([]);
}
