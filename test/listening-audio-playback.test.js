import assert from 'node:assert/strict';
import test from 'node:test';
import { configureTts, lPause, lPlayListeningSet, lPlayRaw, lResume, lStop } from '../public/tts.js';

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

test('owner or route invalidation during manifest loading cannot start static or fallback audio', async () => {
  let releaseManifest;
  const pendingManifest = new Promise((resolve) => { releaseManifest = resolve; });
  const transport = [];
  let current = true;
  let audioCreated = 0;
  let fallbackCalls = 0;
  configureTts({
    loadListeningManifest: async () => pendingManifest,
    createAudio() { audioCreated += 1; return { pause() {}, async play() {} }; },
    lPlayRawFallback() { fallbackCalls += 1; },
    serverAvailable() { return false; },
    slow() { return false; },
    lPlayBtn(status) { transport.push(status); },
    listeningAudioStatus() {},
  });

  const playback = lPlayListeningSet(set, lines, undefined, { isCurrent: () => current });
  assert.equal(transport.at(-1), 'load');
  current = false;
  releaseManifest(manifest());
  assert.equal(await playback, false);
  assert.equal(audioCreated, 0);
  assert.equal(fallbackCalls, 0);

  const transportBefore = transport.length;
  assert.equal(await lPlayListeningSet(set, lines, undefined, { isCurrent: () => false }), false);
  assert.equal(transport.length, transportBefore, 'a stale request must not mutate the current route transport UI');
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

test('active static audio exposes real pause and resume transport states', async () => {
  const transport = [];
  let playCalls = 0;
  let pauseCalls = 0;
  configureTts({
    loadListeningManifest: async () => manifest(),
    createAudio() {
      return {
        pause() { pauseCalls += 1; },
        async play() { playCalls += 1; },
      };
    },
    lPauseFallback() { return false; },
    lResumeFallback() { return false; },
    lPlayRawFallback: async () => false,
    lPlayBtn(status) { transport.push(status); },
    lStopFallback() {},
    serverAvailable() { return false; },
    slow() { return false; },
    listeningAudioStatus() {},
  });

  await lPlayListeningSet(set, lines);
  assert.equal(lPause(), true);
  assert.equal(transport.at(-1), 'pause');
  assert.equal(pauseCalls, 1);
  assert.equal(await lResume(), true);
  assert.equal(transport.at(-1), 'play');
  assert.equal(playCalls, 2, 'resume calls play on the paused asset');
  lStop();
});

test('terminal assisted playback failure reaches error without turning an explicit stop into error', async () => {
  const transport = [];
  configureTts({
    lPlayRawFallback: async () => false,
    lPlayBtn(status) { transport.push(status); },
    lStopFallback() {},
    serverAvailable() { return false; },
  });
  assert.equal(await lPlayRaw(lines), false);
  assert.equal(transport.at(-1), 'error');

  let finishFallback;
  configureTts({ lPlayRawFallback: () => new Promise((resolve) => { finishFallback = resolve; }) });
  const stoppedPlayback = lPlayRaw(lines);
  lStop();
  finishFallback(false);
  assert.equal(await stoppedPlayback, false);
  assert.notEqual(transport.at(-1), 'error', 'user stop remains a stopped state');
});

test('generated media decode or play failure falls back and reaches terminal error', async () => {
  const transport = [];
  let fallbackCalls = 0;
  configureTts({
    apiGetBlob: async () => new Blob(['broken audio'], { type: 'audio/mpeg' }),
    createAudio() { return { pause() {}, play: async () => { throw new Error('decode failed'); } }; },
    lPlayRawFallback: async () => { fallbackCalls += 1; return false; },
    lPlayBtn(status) { transport.push(status); },
    lStopFallback() {},
    serverAvailable() { return true; },
    slow() { return false; },
  });

  assert.equal(await lPlayRaw(lines), false);
  assert.equal(fallbackCalls, 1);
  assert.equal(transport.at(-1), 'error');
});
