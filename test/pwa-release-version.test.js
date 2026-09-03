import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  computePwaReleaseVersion, injectPwaReleaseVersion,
} from '../scripts/pwa-release-version.js';

const worker = `before\n/* build:release-version */\nconst RELEASE_VERSION='source-v1';\n/* end build:release-version */\nafter`;

test('PWA release identity is stable and content-addresses stable shell paths', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'aisy-pwa-release-'));
  try {
    await fs.writeFile(path.join(directory, 'index.html'), '<html>one</html>');
    await fs.writeFile(path.join(directory, 'manifest.json'), '{"theme":"warm-one"}');
    const options = { directory, shell: ['/', '/manifest.json'], workerSource: worker };
    const first = await computePwaReleaseVersion(options);
    assert.equal(await computePwaReleaseVersion(options), first, 'identical inputs must keep one release id');

    await fs.writeFile(path.join(directory, 'manifest.json'), '{"theme":"warm-two"}');
    const changedStableAsset = await computePwaReleaseVersion(options);
    assert.notEqual(changedStableAsset, first,
      'new bytes at the same /manifest.json path must produce a new worker/cache generation');

    const changedWorkerPolicy = await computePwaReleaseVersion({
      ...options, workerSource: `${worker}\nself.policy='new';`,
    });
    assert.notEqual(changedWorkerPolicy, changedStableAsset,
      'worker lifecycle/fetch policy is part of the release identity too');
    assert.match(injectPwaReleaseVersion(worker, changedStableAsset),
      new RegExp(`const RELEASE_VERSION='${changedStableAsset}'`, 'u'));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
