import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { baseMimeType, pruneAudioCache, validateAudioUpload, withTimeout } from '../audio/controls.js';

test('STT upload accepts only bounded audio MIME types', () => {
  assert.equal(baseMimeType('audio/webm;codecs=opus'), 'audio/webm');
  assert.equal(validateAudioUpload('audio/webm;codecs=opus', Buffer.alloc(100), 1000).ok, true);
  assert.equal(validateAudioUpload('application/octet-stream', Buffer.alloc(100), 1000).code, 'UNSUPPORTED_AUDIO_TYPE');
  assert.equal(validateAudioUpload('audio/mp4', Buffer.alloc(0), 1000).code, 'EMPTY_AUDIO');
  assert.equal(validateAudioUpload('audio/mp4', Buffer.alloc(1001), 1000).code, 'AUDIO_TOO_LARGE');
});

test('audio provider timeout rejects stalled work', async () => {
  await assert.rejects(() => withTimeout(new Promise(() => {}), 10, 'TEST_TIMEOUT'), /TEST_TIMEOUT/u);
  assert.equal(await withTimeout(Promise.resolve('ok'), 100), 'ok');
});

test('TTS cache cleanup removes expired and excess hashed files only', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-tts-'));
  try {
    const oldFile = path.join(directory, `${'a'.repeat(64)}.mp3`);
    const newFile = path.join(directory, `${'b'.repeat(64)}.mp3`);
    const unrelated = path.join(directory, 'keep.txt');
    await Promise.all([fs.writeFile(oldFile, Buffer.alloc(10)), fs.writeFile(newFile, Buffer.alloc(20)), fs.writeFile(unrelated, 'keep')]);
    await fs.utimes(oldFile, new Date(0), new Date(0));
    const result = pruneAudioCache(directory, { maxAgeMs: 1000, maxBytes: 100, now: Date.now() });
    assert.equal(result.removed, 1);
    assert.equal((await fs.stat(newFile)).size, 20);
    assert.equal(await fs.readFile(unrelated, 'utf8'), 'keep');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
