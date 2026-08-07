import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('Speaking first-run exposes explicit accent choice, one-time dual setup and separate consent', async () => {
  const source = await fs.readFile(new URL('../public/screens/speaking.js', import.meta.url), 'utf8');
  assert.match(source, /\/api\/v1\/speaking\/accent-profile/u);
  assert.match(source, /Британск/u);
  assert.match(source, /Американск/u);
  assert.match(source, /Не знаю/u);
  assert.match(source, /spAccentStartUnknown/u);
  assert.match(source, /en-GB/u);
  assert.match(source, /en-US/u);
  assert.match(source, /accent-profile\/calibration\/.*\/complete/u);
  assert.match(source, /\/api\/v1\/speaking\/calibration-consent/u);
  assert.match(source, /законн.*представител/iu);
  assert.match(source, /добровольн/iu);
  assert.match(source, /отказ.*не огранич/iu);
  assert.match(source, /X-Speech-Locale/u);
  assert.doesNotMatch(source, /Math\.max\([^\n]*(?:en-GB|en-US)/u,
    'the client must not cherry-pick the higher accent score on ordinary attempts');
});

test('expired owners can open and revoke calibration consent from the auth-only access gate', async () => {
  const [privacy, app] = await Promise.all([
    fs.readFile(new URL('../public/privacy.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8'),
  ]);
  assert.match(privacy, /privacyCalibrationRevoke/u);
  assert.match(privacy, /\/api\/v1\/speaking\/calibration-consent/u);
  assert.match(privacy, /openCalibrationPrivacy/u);
  assert.match(app, /access_gate_privacy/u);
  assert.match(app, /openCalibrationPrivacy/u);
});
