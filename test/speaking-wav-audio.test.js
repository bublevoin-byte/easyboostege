import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePcm16Mono16kWav } from '../speaking/wav-audio.js';
import { testPcmWavAudio } from './support/wav-audio.js';

function appendChunk(wav, chunk) {
  const crafted = Buffer.concat([wav, chunk]);
  crafted.writeUInt32LE(crafted.length - 8, 4);
  return crafted;
}

test('WAV parser derives trusted duration and rejects duplicate or malformed chunk layouts', () => {
  const wav = testPcmWavAudio({ durationSeconds: 3 });
  assert.deepEqual(parsePcm16Mono16kWav(wav), {
    durationSeconds: 3, dataBytes: 96_000, sampleRate: 16_000, channels: 1, bitsPerSample: 16,
  });

  assert.equal(parsePcm16Mono16kWav(appendChunk(wav, wav.subarray(12, 36))), null);
  assert.equal(parsePcm16Mono16kWav(appendChunk(wav, wav.subarray(36))), null);

  const malformedPadding = Buffer.alloc(9);
  malformedPadding.write('JUNK', 0, 'ascii');
  malformedPadding.writeUInt32LE(1, 4);
  malformedPadding[8] = 1;
  assert.equal(parsePcm16Mono16kWav(appendChunk(wav, malformedPadding)), null);

  const trailingGarbage = Buffer.concat([wav, Buffer.from([1])]);
  trailingGarbage.writeUInt32LE(trailingGarbage.length - 8, 4);
  assert.equal(parsePcm16Mono16kWav(trailingGarbage), null);
});
