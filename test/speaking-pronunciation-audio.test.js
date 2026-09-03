import assert from 'node:assert/strict';
import test from 'node:test';

import {
  convertRecordingToPcm16Wav,
  encodePcm16Mono16kWav,
} from '../public/speaking-pronunciation-audio.js';
import { parsePcm16Mono16kWav } from '../speaking/wav-audio.js';

test('pronunciation encoder produces a valid mono PCM16 16 kHz WAV', () => {
  const samples = new Float32Array(16_000);
  samples[0] = -1;
  samples[1] = 1;
  const encoded = encodePcm16Mono16kWav(samples);
  const parsed = parsePcm16Mono16kWav(Buffer.from(encoded));

  assert.equal(parsed.sampleRate, 16_000);
  assert.equal(parsed.channels, 1);
  assert.equal(parsed.bitsPerSample, 16);
  assert.equal(parsed.durationSeconds, 1);
});

test('browser conversion downmixes stereo and resamples before upload', async () => {
  const left = new Float32Array(8_000).fill(0.5);
  const right = new Float32Array(8_000).fill(-0.25);
  let closed = false;
  class FakeAudioContext {
    async decodeAudioData() {
      return {
        numberOfChannels: 2,
        length: 8_000,
        sampleRate: 8_000,
        getChannelData(channel) { return channel === 0 ? left : right; },
      };
    }

    async close() { closed = true; }
  }

  const converted = await convertRecordingToPcm16Wav(new Blob(['encoded browser audio']), {
    AudioContext: FakeAudioContext,
    Blob,
  });
  const parsed = parsePcm16Mono16kWav(Buffer.from(await converted.blob.arrayBuffer()));

  assert.equal(converted.blob.type, 'audio/wav');
  assert.equal(converted.durationSeconds, 1);
  assert.equal(parsed.sampleRate, 16_000);
  assert.equal(parsed.durationSeconds, 1);
  assert.equal(closed, true);
});
