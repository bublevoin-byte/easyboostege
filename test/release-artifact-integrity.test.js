import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  publishReleaseArtifact,
  verifyReleaseArtifact,
} from '../scripts/verify-release-artifact.js';

function record(bytes) {
  return {
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

async function createArtifact() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-release-artifact-'));
  const files = await writeArtifact(directory, 1);
  return { directory, files };
}

async function writeArtifact(directory, release) {
  const files = {
    'assets/app.js': Buffer.from(`export const release = ${release};\n`),
    'index.html': Buffer.from(`<main>Aisy ${release}</main>\n`),
  };
  for (const [name, bytes] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await fs.writeFile(path.join(directory, name), bytes);
  }
  await fs.writeFile(path.join(directory, 'asset-manifest.json'), `${JSON.stringify({
    generatedBy: 'npm run build:frontend',
    releaseVersion: `sha256-${'a'.repeat(64)}`,
    assets: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, record(bytes)])),
  }, null, 2)}\n`);
  return files;
}

test('asset manifest is the digest-complete authority for every built file', async () => {
  const fixture = await createArtifact();
  try {
    const result = await verifyReleaseArtifact({ publicDirectory: fixture.directory });
    assert.equal(result.assets, 2);
    assert.equal(result.files, 3, 'the authority file itself is also part of the frozen artifact');
    assert.match(result.aggregateSha256, /^[a-f0-9]{64}$/u);
  } finally {
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }
});

test('artifact verification rejects changed, missing and undeclared built bytes', async () => {
  for (const failure of ['changed', 'missing', 'extra']) {
    const fixture = await createArtifact();
    try {
      if (failure === 'changed') await fs.appendFile(path.join(fixture.directory, 'assets/app.js'), 'tamper');
      if (failure === 'missing') await fs.rm(path.join(fixture.directory, 'assets/app.js'));
      if (failure === 'extra') await fs.writeFile(path.join(fixture.directory, 'unlisted.txt'), 'extra\n');
      await assert.rejects(
        verifyReleaseArtifact({ publicDirectory: fixture.directory }),
        new RegExp(`${failure === 'extra' ? 'unlisted' : 'assets/app\\.js'}.*(?:digest|bytes|missing|undeclared)`, 'iu'),
      );
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true });
    }
  }
});

test('artifact verification rejects a file added after the initial inventory pass', async () => {
  const fixture = await createArtifact();
  const originalReaddir = fsSync.readdirSync;
  let injected = false;
  try {
    fsSync.readdirSync = function patchedReaddir(directory, ...args) {
      const entries = originalReaddir.call(this, directory, ...args);
      if (!injected && path.resolve(String(directory)) === path.resolve(fixture.directory)) {
        injected = true;
        fsSync.writeFileSync(path.join(fixture.directory, 'late-undeclared.txt'), 'late\n');
      }
      return entries;
    };
    await assert.rejects(
      verifyReleaseArtifact({ publicDirectory: fixture.directory }),
      /late-undeclared\.txt|inventory|undeclared|changed/iu,
    );
    assert.equal(injected, true);
  } finally {
    fsSync.readdirSync = originalReaddir;
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }
});

test('failed post-publication verification restores the exact previous artifact', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-release-publish-'));
  const publicDirectory = path.join(parent, 'public');
  const stagingDirectory = path.join(parent, 'public.building');
  let rejectedCandidate = false;
  try {
    await writeArtifact(publicDirectory, 1);
    await writeArtifact(stagingDirectory, 2);
    await assert.rejects(publishReleaseArtifact({
      publicDirectory,
      stagingDirectory,
      async verify(options) {
        const result = await verifyReleaseArtifact(options);
        if (!rejectedCandidate && path.resolve(options.publicDirectory) === publicDirectory) {
          rejectedCandidate = true;
          throw new Error('injected post-publication verification failure');
        }
        return result;
      },
    }), /post-publication|verification|publish/iu);
    assert.equal(rejectedCandidate, true);
    assert.equal(await fs.readFile(path.join(publicDirectory, 'index.html'), 'utf8'),
      '<main>Aisy 1</main>\n');
    await verifyReleaseArtifact({ publicDirectory });
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('publication preserves primary verification and recovery failures in causal order', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-release-publish-dual-fail-'));
  const publicDirectory = path.join(parent, 'public');
  const stagingDirectory = path.join(parent, 'public.building');
  const rejectedDirectory = `${publicDirectory}.rejected`;
  const primaryFailure = new Error('injected candidate verification primary');
  const recoveryFailure = new Error('injected candidate quarantine recovery failure');
  let publicVerifications = 0;
  try {
    await writeArtifact(publicDirectory, 1);
    await writeArtifact(stagingDirectory, 2);
    await assert.rejects(publishReleaseArtifact({
      publicDirectory,
      stagingDirectory,
      async verify(options) {
        const result = await verifyReleaseArtifact(options);
        if (path.resolve(options.publicDirectory) === publicDirectory
            && ++publicVerifications === 2) throw primaryFailure;
        return result;
      },
      operations: {
        lstat: fs.lstat,
        rm: fs.rm,
        async rename(source, destination) {
          if (path.resolve(destination) === rejectedDirectory) throw recoveryFailure;
          return fs.rename(source, destination);
        },
      },
    }), (error) => {
      assert.ok(error instanceof AggregateError, error?.stack);
      assert.deepEqual(error.errors, [primaryFailure, recoveryFailure]);
      return true;
    });
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('publication keeps the known-good generation across invalid staging and rename failure', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-release-publish-failures-'));
  const publicDirectory = path.join(parent, 'public');
  const stagingDirectory = path.join(parent, 'public.building');
  try {
    await writeArtifact(publicDirectory, 1);
    await writeArtifact(stagingDirectory, 2);
    await fs.appendFile(path.join(stagingDirectory, 'index.html'), 'tamper');
    await assert.rejects(publishReleaseArtifact({ publicDirectory, stagingDirectory }),
      /index\.html.*(?:digest|bytes)/iu);
    assert.equal(await fs.readFile(path.join(publicDirectory, 'index.html'), 'utf8'),
      '<main>Aisy 1</main>\n');

    await fs.rm(stagingDirectory, { recursive: true, force: true });
    await writeArtifact(stagingDirectory, 2);
    await assert.rejects(publishReleaseArtifact({
      publicDirectory,
      stagingDirectory,
      operations: {
        lstat: fs.lstat,
        rm: fs.rm,
        async rename(source, destination) {
          if (path.resolve(source) === stagingDirectory) {
            const error = new Error('injected generation rename failure');
            error.code = 'EIO';
            throw error;
          }
          return fs.rename(source, destination);
        },
      },
    }), /generation rename failure/iu);
    assert.equal(await fs.readFile(path.join(publicDirectory, 'index.html'), 'utf8'),
      '<main>Aisy 1</main>\n');
    await verifyReleaseArtifact({ publicDirectory });
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a partial previous-generation retirement failure keeps the verified candidate authoritative', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-release-retirement-'));
  const publicDirectory = path.join(parent, 'public');
  const stagingDirectory = path.join(parent, 'public.building');
  const recoveryDirectory = `${publicDirectory}.previous`;
  let retirementAttempted = false;
  try {
    await writeArtifact(publicDirectory, 1);
    await writeArtifact(stagingDirectory, 2);
    await assert.rejects(publishReleaseArtifact({
      publicDirectory,
      stagingDirectory,
      operations: {
        lstat: fs.lstat,
        async rm(target, options) {
          if (!retirementAttempted && path.resolve(target) === recoveryDirectory) {
            retirementAttempted = true;
            await fs.rm(path.join(recoveryDirectory, 'assets/app.js'));
            const error = new Error('injected partial retirement failure');
            error.code = 'EIO';
            throw error;
          }
          return fs.rm(target, options);
        },
        rename: fs.rename,
      },
    }), /partial retirement failure/iu);
    assert.equal(retirementAttempted, true);
    assert.equal(await fs.readFile(path.join(publicDirectory, 'index.html'), 'utf8'),
      '<main>Aisy 2</main>\n');
    await verifyReleaseArtifact({ publicDirectory });
    await assert.rejects(fs.access(`${publicDirectory}.rejected`));

    await writeArtifact(stagingDirectory, 3);
    await publishReleaseArtifact({ publicDirectory, stagingDirectory });
    assert.equal(await fs.readFile(path.join(publicDirectory, 'index.html'), 'utf8'),
      '<main>Aisy 3</main>\n');
    await assert.rejects(fs.access(recoveryDirectory));
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('verified publication retires the previous generation only after the post-check', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-release-publish-ok-'));
  const publicDirectory = path.join(parent, 'public');
  const stagingDirectory = path.join(parent, 'public.building');
  try {
    await writeArtifact(publicDirectory, 1);
    await writeArtifact(stagingDirectory, 2);
    const result = await publishReleaseArtifact({ publicDirectory, stagingDirectory });
    assert.equal(result.assets, 2);
    assert.equal(await fs.readFile(path.join(publicDirectory, 'index.html'), 'utf8'),
      '<main>Aisy 2</main>\n');
    await assert.rejects(fs.access(`${publicDirectory}.previous`));
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
