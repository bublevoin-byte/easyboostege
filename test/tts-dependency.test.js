import assert from 'node:assert/strict';
import test from 'node:test';

test('msedge-tts exposes the server TTS API used by the application', async () => {
  const { MsEdgeTTS, OUTPUT_FORMAT } = await import('msedge-tts');
  assert.equal(typeof MsEdgeTTS, 'function');
  assert.equal(typeof MsEdgeTTS.prototype.setMetadata, 'function');
  assert.equal(typeof MsEdgeTTS.prototype.toStream, 'function');
  assert.equal(OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, 'audio-24khz-48kbitrate-mono-mp3');
});
