import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { verifyReleaseArtifact } from '../scripts/verify-release-artifact.js';

test('post-single-build artifact authority verifies every transitive built digest', async () => {
  const publicDirectory = path.resolve('dist/public');
  const result = await verifyReleaseArtifact({ publicDirectory });
  assert.equal(result.assets, 553);
  assert.equal(result.files, 554);
  assert.match(result.releaseVersion, /^sha256-[a-f0-9]{64}$/u);
});
