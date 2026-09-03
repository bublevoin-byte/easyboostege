import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LISTENING_PILOT_CATALOG } from '../public/listening-pilot-v1.js';
import {
  createXaiTtsProvider,
  EMPTY_LISTENING_AUDIO_MANIFEST,
  runListeningAudioPipeline,
} from '../audio/listening-static-audio.js';

const VALID_MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(509, 7)]);

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-listening-audio-'));
  const publicDirectory = path.join(root, 'public');
  const manifestPath = path.join(
    publicDirectory, 'audio', 'listening', 'listening-pilot-v1', 'manifest.json',
  );
  return {
    root,
    publicDirectory,
    manifestPath,
    async seedManifest() {
      await fs.mkdir(path.dirname(manifestPath), { recursive: true });
      await fs.writeFile(manifestPath, `${JSON.stringify(EMPTY_LISTENING_AUDIO_MANIFEST, null, 2)}\n`);
    },
  };
}

test('dry-run validates all 60 sets and reports exact cost without provider calls or writes', async () => {
  const f = await fixture();
  let providerCalls = 0;
  try {
    const result = await runListeningAudioPipeline({
      catalog: LISTENING_PILOT_CATALOG,
      publicDirectory: f.publicDirectory,
      manifestPath: f.manifestPath,
      mode: 'dry-run',
      priceUsdPerMillion: 15,
      provider: async () => { providerCalls += 1; return { mimeType: 'audio/mpeg', bytes: VALID_MP3 }; },
    });

    assert.deepEqual(
      {
        sets: result.setCount,
        assets: result.assetCount,
        missing: result.missingCount,
        characters: result.characterCount,
        estimatedUsd: result.estimatedUsd,
      },
      { sets: 60, assets: 400, missing: 400, characters: 56_914, estimatedUsd: 0.85371 },
    );
    assert.equal(providerCalls, 0);
    await assert.rejects(fs.access(f.manifestPath), { code: 'ENOENT' });
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('generation requires both the paid confirmation and an API key before calling a provider', async () => {
  const f = await fixture();
  let providerCalls = 0;
  const provider = async () => { providerCalls += 1; return { mimeType: 'audio/mpeg', bytes: VALID_MP3 }; };
  try {
    await assert.rejects(
      runListeningAudioPipeline({
        catalog: LISTENING_PILOT_CATALOG,
        publicDirectory: f.publicDirectory,
        manifestPath: f.manifestPath,
        mode: 'generate',
        paidConfirmed: false,
        apiKey: 'test-secret-that-must-not-appear',
        provider,
      }),
      /explicit paid confirmation/u,
    );
    await assert.rejects(
      runListeningAudioPipeline({
        catalog: LISTENING_PILOT_CATALOG,
        publicDirectory: f.publicDirectory,
        manifestPath: f.manifestPath,
        mode: 'generate',
        paidConfirmed: true,
        apiKey: '',
        provider,
      }),
      /XAI_API_KEY/u,
    );
    assert.equal(providerCalls, 0);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('CLI gate fails before network access and never prints the xAI secret', () => {
  const secret = 'test-secret-that-must-never-be-logged';
  const result = spawnSync(process.execPath, ['scripts/listening-static-audio.js', '--paid', '--summary'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, XAI_API_KEY: secret },
    encoding: 'utf8',
  });
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, /explicit paid confirmation/u);
  assert.doesNotMatch(output, new RegExp(secret, 'u'));
});

test('xAI provider follows the current TTS request contract without a real network call', async () => {
  const calls = [];
  const provider = createXaiTtsProvider({
    apiKey: 'fake-key',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'audio/mpeg' }),
        async arrayBuffer() { return VALID_MP3; },
      };
    },
  });

  await provider({ text: 'A British English training line.', providerVoice: 'ara' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.x.ai/v1/tts');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    text: 'A British English training line.',
    voice_id: 'ara',
    language: 'en',
    output_format: { codec: 'mp3', sample_rate: 24_000, bit_rate: 128_000 },
  });
});

test('fake-provider generation publishes valid immutable assets atomically and resumes without repaying', async () => {
  const f = await fixture();
  let providerCalls = 0;
  const provider = async () => {
    providerCalls += 1;
    return { mimeType: 'audio/mpeg; charset=binary', bytes: VALID_MP3 };
  };
  try {
    await f.seedManifest();
    const first = await runListeningAudioPipeline({
      catalog: LISTENING_PILOT_CATALOG,
      publicDirectory: f.publicDirectory,
      manifestPath: f.manifestPath,
      mode: 'generate',
      paidConfirmed: true,
      apiKey: 'fake-key',
      provider,
    });
    assert.equal(first.generatedCount, 400);
    assert.equal(first.skippedCount, 0);
    assert.equal(providerCalls, 400);

    const manifest = JSON.parse(await fs.readFile(f.manifestPath, 'utf8'));
    assert.equal(manifest.assets.length, 400);
    assert.equal(new Set(manifest.assets.map((asset) => asset.path)).size, 400);
    assert.ok(manifest.assets.every((asset) => asset.mimeType === 'audio/mpeg'));
    assert.ok(manifest.assets.every((asset) => asset.bytes === VALID_MP3.length));
    assert.ok(manifest.assets.every((asset) => /^[a-f0-9]{64}$/u.test(asset.sha256)));
    assert.ok(manifest.assets.every((asset) => /-r1-s\d{2}-(?:speaker-[a-f]|interviewer|guest)-(?:female|male)-[1-3]\.mp3$/u.test(asset.path)));

    providerCalls = 0;
    const second = await runListeningAudioPipeline({
      catalog: LISTENING_PILOT_CATALOG,
      publicDirectory: f.publicDirectory,
      manifestPath: f.manifestPath,
      mode: 'generate',
      paidConfirmed: true,
      apiKey: 'fake-key',
      provider,
    });
    assert.equal(second.generatedCount, 0);
    assert.equal(second.skippedCount, 400);
    assert.equal(second.requestCount, 0);
    assert.equal(second.characterCount, 0);
    assert.equal(second.estimatedUsd, 0);
    assert.equal(providerCalls, 0);
    assert.deepEqual(
      (await fs.readdir(path.dirname(f.manifestPath))).filter((name) => name.includes('.tmp-')),
      [],
    );

    const damagedPath = path.join(f.publicDirectory, manifest.assets[0].path.slice(1));
    await fs.writeFile(damagedPath, Buffer.from('not-an-mp3'));
    const repaired = await runListeningAudioPipeline({
      catalog: LISTENING_PILOT_CATALOG,
      publicDirectory: f.publicDirectory,
      manifestPath: f.manifestPath,
      mode: 'generate',
      paidConfirmed: true,
      apiKey: 'fake-key',
      provider,
    });
    assert.equal(repaired.generatedCount, 1);
    assert.equal(repaired.skippedCount, 399);
    assert.equal(providerCalls, 1);
    assert.deepEqual((await fs.readFile(damagedPath)).subarray(0, 3), Buffer.from('ID3'));
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('manifest metadata cannot bind a safe path to the wrong catalog set', async () => {
  const f = await fixture();
  try {
    await f.seedManifest();
    const planOnly = await runListeningAudioPipeline({
      catalog: LISTENING_PILOT_CATALOG,
      publicDirectory: f.publicDirectory,
      manifestPath: f.manifestPath,
    });
    const wrongAsset = {
      setId: 'listening-pilot-v1.true-false.not-the-planned-set',
      revision: 1,
      type: 'true_false',
      segmentIndex: 0,
      role: 'speaker_a',
      voiceSlot: 'female_1',
      providerVoice: 'ara',
      path: planOnly.missing[0],
      mimeType: 'audio/mpeg',
      bytes: VALID_MP3.length,
      sha256: 'a'.repeat(64),
    };
    await fs.writeFile(f.manifestPath, JSON.stringify({
      ...EMPTY_LISTENING_AUDIO_MANIFEST,
      assets: [wrongAsset],
    }));
    await assert.rejects(
      runListeningAudioPipeline({
        catalog: LISTENING_PILOT_CATALOG,
        publicDirectory: f.publicDirectory,
        manifestPath: f.manifestPath,
      }),
      /does not match the catalog plan/u,
    );
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});

test('a corrupt provider response is never published or added to the manifest', async () => {
  const f = await fixture();
  try {
    await f.seedManifest();
    await assert.rejects(
      runListeningAudioPipeline({
        catalog: LISTENING_PILOT_CATALOG,
        publicDirectory: f.publicDirectory,
        manifestPath: f.manifestPath,
        mode: 'generate',
        paidConfirmed: true,
        apiKey: 'fake-key',
        provider: async () => ({ mimeType: 'application/json', bytes: Buffer.from('{"error":"bad"}') }),
      }),
      /audio\/mpeg/u,
    );
    const manifest = JSON.parse(await fs.readFile(f.manifestPath, 'utf8'));
    assert.deepEqual(manifest.assets, []);
    const files = await fs.readdir(path.dirname(f.manifestPath));
    assert.deepEqual(files, ['manifest.json']);
  } finally {
    await fs.rm(f.root, { recursive: true, force: true });
  }
});
