import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const serverRoot = fileURLToPath(new URL('..', import.meta.url));

test('offline calibration CLI emits a fail-closed versioned report without provider calls', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easyboost-speaking-calibration-'));
  const output = path.join(directory, 'report.json');
  try {
    const result = spawnSync(process.execPath, [
      path.join(serverRoot, 'scripts', 'speaking-calibration-report.js'),
      path.join(serverRoot, 'quality', 'speaking-calibration-template.json'),
      '--report-version=cli-contract-v1',
      `--output=${output}`,
    ], { cwd: serverRoot, encoding: 'utf8', env: { ...process.env, XAI_API_KEY: '', AZURE_SPEECH_KEY: '' } });
    assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(report.reportVersion, 'cli-contract-v1');
    assert.equal(report.metricsStatus, 'fail');
    assert.equal(report.releaseStatus, 'not_validated');
    assert.match(report.reportDigest, /^[a-f0-9]{64}$/u);
    assert.ok(report.validationErrors.length > 0);
    assert.match(result.stderr, /release_status=not_validated/u);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
