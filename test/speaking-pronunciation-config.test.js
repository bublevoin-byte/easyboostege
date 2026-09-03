import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function readConfig(extraEnv = {}) {
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    "const { config } = await import('./config.js'); console.log(JSON.stringify(config.speakingPronunciation));",
  ], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      AZURE_SPEECH_KEY: '',
      AZURE_SPEECH_REGION: '',
      SPEAKING_PRONUNCIATION_ENABLED: '',
      SPEAKING_PRONUNCIATION_TIMEOUT_MS: '',
      SPEAKING_PRONUNCIATION_MAX_AUDIO_BYTES: '',
      SPEAKING_PRONUNCIATION_MAX_AUDIO_SECONDS: '',
      ...extraEnv,
    },
  });
  return result;
}

test('pronunciation configuration is disabled and bounded by default', () => {
  const result = readConfig();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    enabled: false,
    azureKey: '',
    azureRegion: '',
    timeoutMs: 30_000,
    maxAudioBytes: 10 * 1024 * 1024,
    maxAudioSeconds: 180,
  });
});

test('pronunciation configuration uses only documented server-side environment names', () => {
  const result = readConfig({
    SPEAKING_PRONUNCIATION_ENABLED: 'true',
    AZURE_SPEECH_KEY: 'server-only-key',
    AZURE_SPEECH_REGION: 'uksouth',
    SPEAKING_PRONUNCIATION_TIMEOUT_MS: '12000',
    SPEAKING_PRONUNCIATION_MAX_AUDIO_BYTES: '2097152',
    SPEAKING_PRONUNCIATION_MAX_AUDIO_SECONDS: '90',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    enabled: true,
    azureKey: 'server-only-key',
    azureRegion: 'uksouth',
    timeoutMs: 12_000,
    maxAudioBytes: 2 * 1024 * 1024,
    maxAudioSeconds: 90,
  });
});

test('pronunciation configuration rejects unsafe bounds before startup', () => {
  const result = readConfig({ SPEAKING_PRONUNCIATION_MAX_AUDIO_SECONDS: '181' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SPEAKING_PRONUNCIATION_MAX_AUDIO_SECONDS must be an integer between 1 and 180/u);
});
