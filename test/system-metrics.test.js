import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectSystemMetrics } from '../observability/system-metrics.js';

test('system metrics report disk and latest backup freshness', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-metrics-'));
  try {
    const backups = path.join(directory, 'backups');
    await fs.mkdir(backups);
    const file = path.join(backups, 'easyboost-test.dump');
    await fs.writeFile(file, 'backup');
    const metrics = await collectSystemMetrics(directory);
    assert.ok(metrics.disk.totalBytes > 0);
    assert.ok(metrics.disk.usedPercent >= 0 && metrics.disk.usedPercent <= 100);
    assert.equal(metrics.backup.file, 'easyboost-test.dump');
    assert.equal(metrics.backup.fresh, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('system metrics report a missing backup as not fresh', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-metrics-'));
  try {
    assert.deepEqual((await collectSystemMetrics(directory)).backup, {
      file: null, sizeBytes: 0, createdAt: null, ageHours: null, fresh: false,
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
