import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

async function read(relativePath) {
  return fs.readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('accent calibration is documented as a separate, blinded and expiring data flow', async () => {
  const [retention, operations, schema] = await Promise.all([
    read('docs/DATA_RETENTION.md'),
    read('docs/SPEAKING_PRONUNCIATION_OPERATIONS.md'),
    read('docs/DATABASE_SCHEMA.md'),
  ]);
  assert.match(retention, /Speaking accent calibration/u);
  assert.match(retention, /180 (?:calendar )?days/u);
  assert.match(retention, /revok/iu);
  assert.match(retention, /anonymous labels/iu);
  assert.match(retention, /setup lifecycle metadata/iu);
  assert.match(retention, /evidence keys/iu);
  assert.match(retention, /immutable server-owned task and rubric snapshot/iu);
  assert.match(operations, /two independent blinded reviews/iu);
  assert.match(operations, /third independent adjudicator/iu);
  assert.match(operations, /guardian/iu);
  assert.match(operations, /does not restrict training/iu);
  assert.match(operations, /manual profile selection cancels a pending setup/iu);
  assert.match(operations, /active reviewer lease never extends the 180-day boundary/iu);
  assert.match(operations, /eligible row is selected in SQL/iu);
  assert.match(schema, /049_speaking_accent_calibration\.sql/u);
  assert.match(schema, /speaking_accent_profile_history/u);
  assert.match(schema, /speaking_calibration_samples/u);
  assert.match(schema, /BYTEA/u);
  assert.match(schema, /accent_profile_revision/u);
  assert.match(schema, /pending`, `completed` or `cancelled`/u);
  assert.match(schema, /canonical profile under the owner lock/iu);
  assert.match(schema, /task_snapshot/u);
  assert.match(schema, /rubric_snapshot/u);
});

test('OpenAPI publishes learner and blinded expert accent-calibration contracts', async () => {
  const openapi = await read('docs/openapi.yaml');
  for (const path of [
    '/api/v1/speaking/accent-profile:',
    '/api/v1/speaking/accent-profile/calibration:',
    '/api/v1/speaking/accent-profile/calibration/{setupId}/complete:',
    '/api/v1/speaking/calibration-consent:',
    '/api/v1/speaking/calibration-samples:',
    '/api/v1/speaking/calibration-reviews/next:',
    '/api/v1/speaking/calibration-reviews/{sampleId}/audio:',
    '/api/v1/speaking/calibration-reviews/{sampleId}:',
  ]) assert.match(openapi, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(openapi, /SpeakingAccentProfile:/u);
  assert.match(openapi, /SpeakingCalibrationConsent:/u);
  assert.match(openapi, /SpeakingCalibrationExpertCard:/u);
  assert.match(openapi, /SpeakingAccentCalibrationExport:/u);
  assert.match(openapi, /setup lifecycle metadata/iu);
  assert.match(openapi, /immutable enrolled task and rubric snapshots/iu);
  assert.match(openapi, /No direct learner identifiers are exposed/iu);
  assert.match(openapi, /180 days/u);
});

test('production server wires accent repositories through the retention service lifecycle', async () => {
  const [database, server, retentionService] = await Promise.all([
    read('db.js'),
    read('server.js'),
    read('speaking/calibration-retention-service.js'),
  ]);
  for (const method of [
    'getSpeakingAccentProfile', 'setSpeakingAccentProfile', 'startSpeakingAccentCalibration',
    'getPendingSpeakingAccentCalibration', 'completeSpeakingAccentCalibration',
    'getSpeakingCalibrationConsent', 'setSpeakingCalibrationConsent',
    'createSpeakingCalibrationSample', 'claimSpeakingCalibrationSample',
    'getSpeakingCalibrationAudio', 'submitSpeakingCalibrationReview',
    'purgeExpiredSpeakingCalibrationSamples',
  ]) {
    assert.match(database, new RegExp(`export const ${method}\\b`, 'u'));
    assert.match(server, new RegExp(`\\b${method}\\b`, 'u'));
  }
  assert.match(server, /createSpeakingCalibrationRetentionService/u);
  assert.match(server, /speakingCalibrationRetention\.start\(\)/u);
  assert.match(server, /speakingCalibrationRetention\.stop\(\)/u);
  assert.doesNotMatch(server, /async function purgeSpeakingCalibrationRetention/u);
  assert.match(retentionService, /setIntervalFn/u);
  assert.match(retentionService, /timer\?\.unref\?\.\(\)/u);
  assert.match(retentionService, /clearIntervalFn\(timer\)/u);
  assert.match(retentionService, /speaking_calibration_retention_failed/u);
});
