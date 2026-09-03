import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('Speaking public contracts contain no completed-ticket deferral marker', async () => {
  const paths = [
    'speaking/sequential-session.js',
    'speaking/task4-session.js',
    'speaking/full-section-session.js',
    'public/modules/speaking.js',
    'public/speaking-sequential-runtime.js',
    'public/speaking-task4-runtime.js',
    'public/speaking-full-runtime.js',
    'public/screens/speaking.js',
    'docs/openapi.yaml',
  ];
  const sources = await Promise.all(paths.map((pathname) => fs.readFile(new URL(pathname, root), 'utf8')));
  assert.doesNotMatch(sources.join('\n'), /deferred_to_tickets_06_07/u);
  assert.doesNotMatch(
    sources.join('\n'),
    /until an acoustic provider is connected|automated assessment remains deferred/iu,
  );
  assert.doesNotMatch(sources.join('\n'), /оценка позже/iu);
  assert.match(sources.join('\n'), /примерная оценка после сдачи/iu);
  assert.match(sources.join('\n'), /not_requested/u);
});

test('Speaking 2 release evidence records exact offline gates and owner-only paid rollout actions', async () => {
  const evidence = await fs.readFile(new URL('docs/SPEAKING_2_RELEASE_EVIDENCE.md', root), 'utf8');
  for (const gate of [
    'npm.cmd run lint',
    'npm.cmd run check',
    'npm.cmd test',
    'npm.cmd run test:postgres',
    'npm.cmd run test:e2e',
    'npm.cmd run test:e2e:performance',
    'npm.cmd run security:secrets',
    'npm.cmd run security:history',
  ]) assert.match(evidence, new RegExp(gate.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(evidence, /microsoft-cognitiveservices-speech-sdk/u);
  for (const name of [
    'SPEAKING_PRONUNCIATION_ENABLED', 'AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION',
    'SPEAKING_PRONUNCIATION_TIMEOUT_MS', 'SPEAKING_PRONUNCIATION_MAX_AUDIO_BYTES',
    'SPEAKING_PRONUNCIATION_MAX_AUDIO_SECONDS',
  ]) assert.match(evidence, new RegExp(name, 'u'));
  assert.match(evidence, /separate staging Speech resource/iu);
  assert.match(evidence, /owner-approved paid smoke/iu);
  assert.match(evidence, /No package was installed/iu);
  assert.match(evidence, /No provider or paid call was made/iu);
  assert.doesNotMatch(evidence, /[A-Za-z0-9+/]{48}={0,2}/u, 'release evidence must not contain key-like base64');
});

test('Speaking 2 release tracker uses the canonical ticket status vocabulary', async () => {
  const [ticket, progress] = await Promise.all([
    fs.readFile(new URL('.scratch/speaking-2-pilot/issues/10-release-hardening.md', root), 'utf8'),
    fs.readFile(new URL('PROGRESS.md', root), 'utf8'),
  ]);
  assert.match(ticket, /^Status: done$/mu);
  assert.match(progress, /^\| 10 \| Выпускной аудит и release candidate \| done \|$/mu);
});
