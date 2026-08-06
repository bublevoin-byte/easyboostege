import assert from 'node:assert/strict';
import test from 'node:test';
import { configureTts, lPlayListeningSet, lPlayRaw, lStop } from '../public/tts.js';

const set = {
  id: 'listening-pilot-v1.true-false.city-library',
  revision: 1,
};
const lines = [
  { s: 0, t: 'First segment.' },
  { s: 1, t: 'Second segment.' },
];

function manifest() {
  return {
    schemaVersion: 1,
    catalogId: 'listening-pilot-v1',
    catalogRevision: 1,
    assets: [0, 1].map((segmentIndex) => ({
      setId: set.id,
      revision: 1,
      type: 'true_false',
      segmentIndex,
      role: segmentIndex ? 'speaker_b' : 'speaker_a',
      voiceSlot: segmentIndex ? 'female_1' : 'male_1',
      providerVoice: segmentIndex ? 'ara' : 'rex',
      path: `/audio/listening/listening-pilot-v1/true-false/city-library-r1-s0${segmentIndex + 1}-${segmentIndex ? 'speaker-b-female-1' : 'speaker-a-male-1'}.mp3`,
      mimeType: 'audio/mpeg',
      bytes: 512,
      sha256: 'a'.repeat(64),
    })),
  };
}

test('listening playback prefers ordered manifest MP3 segments and stop pauses the active asset', async () => {
  const played = [];
  const statuses = [];
  const audios = [];
  let fallbackCalls = 0;
  configureTts({
    loadListeningManifest: async () => manifest(),
    createAudio(url) {
      const audio = {
        url,
        paused: false,
        pause() { this.paused = true; },
        async play() { played.push(url); },
      };
      audios.push(audio);
      return audio;
    },
    lPlayRawFallback() { fallbackCalls += 1; },
    serverAvailable() { return false; },
    slow() { return false; },
    listeningAudioStatus(status) { statuses.push(status); },
  });

  await lPlayListeningSet(set, lines);
  assert.deepEqual(played, [manifest().assets[0].path]);
  audios[0].onended();
  await Promise.resolve();
  assert.deepEqual(played, manifest().assets.map((asset) => asset.path));
  lStop();
  assert.equal(audios[1].paused, true);
  assert.equal(fallbackCalls, 0);
  assert.ok(statuses.includes('static'));
});

test('missing, failed and slow static audio use the explicitly labelled assisted fallback', async () => {
  const fallback = [];
  const statuses = [];
  let slow = false;
  configureTts({
    loadListeningManifest: async () => ({ ...manifest(), assets: [] }),
    createAudio() { throw new Error('static audio must not be constructed'); },
    lPlayRawFallback(value) { fallback.push(value); },
    serverAvailable() { return false; },
    slow() { return slow; },
    listeningAudioStatus(status) { statuses.push(status); },
  });
  await lPlayListeningSet(set, lines);
  assert.equal(fallback.length, 1);
  assert.equal(statuses.at(-1), 'fallback');

  slow = true;
  await lPlayListeningSet(set, lines);
  assert.equal(fallback.length, 2);
  assert.equal(statuses.at(-1), 'assisted-slow');

  configureTts({
    loadListeningManifest: async () => manifest(),
    createAudio() {
      return { pause() {}, play: async () => { throw new Error('decode failed'); } };
    },
    lPlayRawFallback(value) { fallback.push(value); },
    serverAvailable() { return false; },
    slow() { return false; },
    listeningAudioStatus(status) { statuses.push(status); },
  });
  await lPlayListeningSet(set, lines);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fallback.length, 3);
  assert.equal(statuses.at(-1), 'fallback-error');
});

test('stop during manifest loading prevents delayed static playback and fallback', async () => {
  let releaseManifest;
  const pendingManifest = new Promise((resolve) => { releaseManifest = resolve; });
  let audioCreated = 0;
  let fallbackCalls = 0;
  configureTts({
    loadListeningManifest: async () => pendingManifest,
    createAudio() { audioCreated += 1; return { pause() {}, async play() {} }; },
    lPlayRawFallback() { fallbackCalls += 1; },
    serverAvailable() { return false; },
    slow() { return false; },
    listeningAudioStatus() {},
  });

  const playback = lPlayListeningSet(set, lines);
  lStop();
  releaseManifest(manifest());
  await playback;

  assert.equal(audioCreated, 0);
  assert.equal(fallbackCalls, 0);
});

test('raw TTS playback resolves only after the final audio segment ends', async () => {
  let announceAudio;
  const audioCreated = new Promise((resolve) => { announceAudio = resolve; });
  configureTts({
    apiGetBlob: async () => new Blob(['question audio'], { type: 'audio/mpeg' }),
    createAudio() {
      const audio = { pause() {}, async play() {} };
      announceAudio(audio);
      return audio;
    },
    lPlayRawFallback: async () => false,
    serverAvailable() { return true; },
    slow() { return false; },
    lPlayBtn() {},
    lStopFallback() {},
  });

  let settled = false;
  const playback = lPlayRaw([{ s: 1, t: 'What do you enjoy doing after school?' }])
    .then((result) => { settled = true; return result; });
  const audio = await audioCreated;
  await Promise.resolve();
  assert.equal(settled, false);

  audio.onended();
  assert.equal(await playback, true);
});
