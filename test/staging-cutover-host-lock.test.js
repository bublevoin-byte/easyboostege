import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  acquireStagingCutoverHostLock,
  releaseStagingCutoverHostLock,
  verifyStagingCutoverHostLock,
} from '../scripts/staging-cutover-host-lock.js';

const MODULE = fileURLToPath(new URL('../scripts/staging-cutover-host-lock.js', import.meta.url));
const MODULE_URL = pathToFileURL(MODULE).href;
const LINUX = process.platform === 'linux';
const SHA = (character) => character.repeat(64);
const BASE = Object.freeze({
  bridgeSha256: SHA('1'),
  bundleSha256: SHA('2'),
  legacyAppMode: '700',
  legacyAuthoritySha256: SHA('6'),
  legacyComposeMode: '664',
  legacyComposeSha256: SHA('3'),
  legacyMarkerMode: '644',
  legacyMarkerSha256: SHA('4'),
  nonce: SHA('5'),
});

const PHASE_WORKER = String.raw`
const lock = await import(process.argv[1]);
const request = JSON.parse(process.argv[2]);
const phase = process.argv[3];
const mode = process.argv[4];
const afterPhase = (observed) => {
  if (observed === phase) process.kill(process.pid, 'SIGKILL');
};
const capability = lock.acquireStagingCutoverHostLock({
  ...request,
  afterPhase,
  ownerPid: process.pid,
});
if (mode === 'release') {
  lock.releaseStagingCutoverHostLock(capability, {
    afterPhase,
    ownerPid: process.pid,
  });
}
process.stdout.write(JSON.stringify(capability));
`;

const LIVE_WORKER = String.raw`
const lock = await import(process.argv[1]);
const request = JSON.parse(process.argv[2]);
const capability = lock.acquireStagingCutoverHostLock({
  ...request,
  ownerPid: process.pid,
});
process.stdout.write(JSON.stringify(capability) + '\n');
setInterval(() => {}, 1000);
`;

const CLI_WRAPPER = String.raw`
const { spawnSync } = require('node:child_process');
const result = spawnSync(process.execPath, JSON.parse(process.argv[1]), {
  encoding: 'utf8',
});
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 70);
`;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easyboost-cutover-host-lock-'));
  fs.chmodSync(root, 0o700);
  return Object.freeze({
    lockDirectory: path.join(root, 'host-operation.lock'),
    root,
  });
}

function request(lockDirectory, overrides = {}) {
  return Object.freeze({
    ...BASE,
    appDirectory: path.join(path.dirname(lockDirectory), 'staging-app'),
    lockDirectory,
    ...overrides,
  });
}

function portableIdentity(stat) {
  const directory = stat.isDirectory();
  const bigint = typeof stat.mode === 'bigint';
  const permissions = directory ? 0o700 : 0o600;
  const mask = bigint ? 0o777n : 0o777;
  const normalizedMode = (stat.mode & ~mask) | (bigint ? BigInt(permissions) : permissions);
  const userId = typeof process.getuid === 'function' ? process.getuid() : 0;
  return new Proxy(stat, {
    get(target, property) {
      if (property === 'mode') return normalizedMode;
      if (property === 'uid') return bigint ? BigInt(userId) : userId;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function portableDependencies(boot) {
  const userId = typeof process.getuid === 'function' ? process.getuid() : 0;
  const filesystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'fsyncSync') return () => {};
      if (property === 'lstatSync') {
        return (candidate, options) => {
          if (process.platform === 'win32' && /^\/proc\/[1-9][0-9]*$/u.test(candidate)) {
            const pid = Number(candidate.slice('/proc/'.length));
            return {
              dev: options?.bigint ? 1n : 1,
              ino: options?.bigint ? BigInt(pid) : pid,
              isDirectory: () => true,
              isFile: () => false,
              isSymbolicLink: () => false,
              mode: options?.bigint ? 0o40700n : 0o40700,
              uid: options?.bigint ? BigInt(userId) : userId,
            };
          }
          return portableIdentity(target.lstatSync(candidate, options));
        };
      }
      if (property === 'fstatSync') {
        return (descriptor, options) => portableIdentity(target.fstatSync(descriptor, options));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return Object.freeze({
    filesystem,
    noReplacePlatform: 'linux',
    readBootId: () => boot.value,
    readProcessStat: (pid) => Object.freeze({ parentPid: 0, startTime: String(pid + 100) }),
    runNoReplaceMove: (_executable, args) => {
      fs.renameSync(args.at(-2), args.at(-1));
      return Object.freeze({ status: 0 });
    },
    userId,
  });
}

function runPhaseWorker(specification, phase = '', mode = 'acquire') {
  return spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    PHASE_WORKER,
    MODULE_URL,
    JSON.stringify(specification),
    phase,
    mode,
  ], { encoding: 'utf8' });
}

function runWrappedCli(args) {
  return spawnSync(process.execPath, [
    '-e', CLI_WRAPPER, JSON.stringify([MODULE, ...args]),
  ], { encoding: 'utf8' });
}

function assertKilled(result) {
  assert.equal(result.status, null, result.stderr);
  assert.equal(result.signal, 'SIGKILL', result.stderr);
}

function assertBoundedParentState(root) {
  const entries = fs.readdirSync(root);
  assert.ok(entries.length <= 2, `unexpected cutover host-lock debris: ${entries.join(', ')}`);
  assert.equal(entries.some((entry) => entry.endsWith('.preparing')), false);
}

function acquireAndRelease(specification) {
  const capability = acquireStagingCutoverHostLock({
    ...specification,
    ownerPid: process.pid,
  });
  assert.equal(verifyStagingCutoverHostLock(capability, { ownerPid: process.pid }), true);
  assert.equal(releaseStagingCutoverHostLock(capability, { ownerPid: process.pid }), true);
  return capability;
}

function waitForLine(stream) {
  return new Promise((resolve, reject) => {
    let buffered = '';
    const onData = (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline < 0) return;
      stream.off('data', onData);
      resolve(buffered.slice(0, newline));
    };
    stream.on('data', onData);
    stream.once('error', reject);
  });
}

test('deterministic seam resumes thrown initial, adoption, and release boundaries', () => {
  const initialPhases = [
    'after-prepared-directory',
    'after-prepared-record',
    'after-published-directory',
  ];
  const adoptionPhases = [
    'after-adoption-prepared',
    'after-adoption-linked',
    'after-adoption-source-cleanup',
    'after-adoption-durable',
  ];
  for (const phase of initialPhases) {
    const current = fixture();
    const boot = { value: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
    const dependencies = portableDependencies(boot);
    const specification = request(current.lockDirectory);
    try {
      assert.throws(() => acquireStagingCutoverHostLock({
        ...specification,
        ...dependencies,
        afterPhase: (observed) => {
          if (observed === phase) throw new Error(`stop:${phase}`);
        },
        ownerPid: process.pid,
      }), new RegExp(`stop:${phase}`, 'u'));
      const capability = acquireStagingCutoverHostLock({
        ...specification,
        ...dependencies,
        ownerPid: process.pid,
      });
      assert.equal(verifyStagingCutoverHostLock(capability, {
        ...dependencies,
        ownerPid: process.pid,
      }), true);
    } finally {
      fs.rmSync(current.root, { force: true, recursive: true });
    }
  }
  for (const phase of adoptionPhases) {
    const current = fixture();
    const boot = { value: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
    const dependencies = portableDependencies(boot);
    const specification = request(current.lockDirectory);
    try {
      acquireStagingCutoverHostLock({
        ...specification,
        ...dependencies,
        ownerPid: process.pid,
      });
      boot.value = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      assert.throws(() => acquireStagingCutoverHostLock({
        ...specification,
        ...dependencies,
        afterPhase: (observed) => {
          if (observed === phase) throw new Error(`stop:${phase}`);
        },
        ownerPid: process.pid,
      }), new RegExp(`stop:${phase}`, 'u'));
      const capability = acquireStagingCutoverHostLock({
        ...specification,
        ...dependencies,
        ownerPid: process.pid,
      });
      assert.equal(releaseStagingCutoverHostLock(capability, {
        ...dependencies,
        ownerPid: process.pid,
      }), true);
      assertBoundedParentState(current.root);
    } finally {
      fs.rmSync(current.root, { force: true, recursive: true });
    }
  }
  const current = fixture();
  const boot = { value: 'cccccccc-cccc-cccc-cccc-cccccccccccc' };
  const dependencies = portableDependencies(boot);
  const specification = request(current.lockDirectory);
  try {
    const capability = acquireStagingCutoverHostLock({
      ...specification,
      ...dependencies,
      ownerPid: process.pid,
    });
    assert.throws(() => releaseStagingCutoverHostLock(capability, {
      ...dependencies,
      afterPhase: (phase) => {
        if (phase === 'after-released-directory') throw new Error('stop:release');
      },
      ownerPid: process.pid,
    }), /stop:release/u);
    const resumed = acquireStagingCutoverHostLock({
      ...specification,
      ...dependencies,
      ownerPid: process.pid,
    });
    assert.equal(releaseStagingCutoverHostLock(resumed, {
      ...dependencies,
      ownerPid: process.pid,
    }), true);
    assertBoundedParentState(current.root);
  } finally {
    fs.rmSync(current.root, { force: true, recursive: true });
  }
});

test('a different journal cannot accumulate another terminal namespace', () => {
  const current = fixture();
  const boot = { value: 'dddddddd-dddd-dddd-dddd-dddddddddddd' };
  const dependencies = portableDependencies(boot);
  const specification = request(current.lockDirectory);
  try {
    const capability = acquireStagingCutoverHostLock({
      ...specification,
      ...dependencies,
      ownerPid: process.pid,
    });
    releaseStagingCutoverHostLock(capability, {
      ...dependencies,
      ownerPid: process.pid,
    });
    assert.throws(() => acquireStagingCutoverHostLock({
      ...specification,
      ...dependencies,
      nonce: SHA('6'),
      ownerPid: process.pid,
    }), /another journal/u);
    assert.equal(fs.readdirSync(current.root).length, 1);
  } finally {
    fs.rmSync(current.root, { force: true, recursive: true });
  }
});

test('an identical digest tuple cannot adopt a lock from another staging root', () => {
  const current = fixture();
  const boot = { value: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' };
  const dependencies = portableDependencies(boot);
  const firstRoot = path.join(current.root, 'staging-a');
  const secondRoot = path.join(current.root, 'staging-b');
  const first = request(current.lockDirectory, { appDirectory: firstRoot });
  try {
    acquireStagingCutoverHostLock({
      ...first,
      ...dependencies,
      ownerPid: process.pid,
    });
    const ownerPath = path.join(current.lockDirectory, 'owner.json');
    const beforeBytes = fs.readFileSync(ownerPath);
    const beforeIdentity = fs.lstatSync(ownerPath, { bigint: true });
    boot.value = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    assert.throws(() => acquireStagingCutoverHostLock({
      ...first,
      ...dependencies,
      appDirectory: secondRoot,
      ownerPid: process.pid,
    }), /another journal|binding/u);
    const afterIdentity = fs.lstatSync(ownerPath, { bigint: true });
    assert.deepEqual(fs.readFileSync(ownerPath), beforeBytes);
    assert.equal(afterIdentity.dev, beforeIdentity.dev);
    assert.equal(afterIdentity.ino, beforeIdentity.ino);

    assert.throws(() => acquireStagingCutoverHostLock({
      ...first,
      ...dependencies,
      legacyAppMode: '755',
      ownerPid: process.pid,
    }), /another journal|binding/u);
    assert.deepEqual(fs.readFileSync(ownerPath), beforeBytes,
      'a different observed legacy mode tuple must not mutate the existing lock');

    assert.throws(() => acquireStagingCutoverHostLock({
      ...first,
      ...dependencies,
      legacyComposeMode: '644',
      ownerPid: process.pid,
    }), /another journal|binding/u);
    assert.deepEqual(fs.readFileSync(ownerPath), beforeBytes,
      'a different but valid legacy Compose mode must not adopt the existing lock');

    assert.throws(() => acquireStagingCutoverHostLock({
      ...first,
      ...dependencies,
      legacyAuthoritySha256: SHA('7'),
      ownerPid: process.pid,
    }), /another journal|binding/u);
    assert.deepEqual(fs.readFileSync(ownerPath), beforeBytes,
      'a recreated predecessor runtime must not adopt the existing lock');
  } finally {
    fs.rmSync(current.root, { force: true, recursive: true });
  }
});

test('group-writable legacy Compose is admissible only under the exact 0700 app-root tuple', () => {
  const current = fixture();
  const dependencies = portableDependencies({
    value: 'abababab-abab-abab-abab-abababababab',
  });
  const specification = request(current.lockDirectory);
  try {
    assert.throws(() => acquireStagingCutoverHostLock({
      ...specification,
      ...dependencies,
      legacyAppMode: '755',
      ownerPid: process.pid,
    }), /binding.*invalid/u);
    assert.equal(fs.existsSync(current.lockDirectory), false,
      'an invalid mode tuple must fail before publishing any lock state');
  } finally {
    fs.rmSync(current.root, { force: true, recursive: true });
  }
});

test('descriptor-bounded inventories reject overflow and control names without cleanup', () => {
  for (const kind of ['overflow', 'control']) {
    const current = fixture();
    const boot = { value: 'acacacac-acac-acac-acac-acacacacacac' };
    const dependencies = portableDependencies(boot);
    const specification = request(current.lockDirectory);
    const candidate = `${current.lockDirectory}.preparing`;
    try {
      fs.mkdirSync(candidate, { mode: 0o700 });
      if (kind === 'overflow') {
        for (let index = 0; index < 40; index += 1) {
          fs.writeFileSync(path.join(candidate, `foreign-${index}`), 'foreign', { mode: 0o600 });
        }
      } else {
        fs.writeFileSync(path.join(candidate, 'foreign\u0085name'), 'foreign', { mode: 0o600 });
      }
      const before = fs.readdirSync(candidate).sort();
      assert.throws(() => acquireStagingCutoverHostLock({
        ...specification, ...dependencies, ownerPid: process.pid,
      }), /entry bound|noncanonical name/u);
      assert.deepEqual(fs.readdirSync(candidate).sort(), before);
      assert.equal(fs.existsSync(current.lockDirectory), false);
    } finally {
      fs.rmSync(current.root, { force: true, recursive: true });
    }
  }
});

test('descriptor inventory detects a candidate pathname replacement', () => {
  const current = fixture();
  const boot = { value: 'adadadad-adad-adad-adad-adadadadadad' };
  const baseDependencies = portableDependencies(boot);
  const specification = request(current.lockDirectory);
  const candidate = `${current.lockDirectory}.preparing`;
  const displaced = `${candidate}.displaced`;
  let swapped = false;
  try {
    assert.throws(() => acquireStagingCutoverHostLock({
      ...specification,
      ...baseDependencies,
      descriptorDirectoryPath(_descriptor, directory) {
        if (!swapped && directory === candidate) {
          fs.renameSync(candidate, displaced);
          fs.mkdirSync(candidate, { mode: 0o700 });
          swapped = true;
        }
        return directory;
      },
      ownerPid: process.pid,
    }), /directory changed during inventory/u);
    assert.equal(swapped, true);
    assert.equal(fs.existsSync(candidate), true);
    assert.equal(fs.existsSync(displaced), true);
  } finally {
    fs.rmSync(current.root, { force: true, recursive: true });
  }
});

test('canonical, adoption and released namespaces all enforce bounded inventory', () => {
  for (const state of ['canonical', 'adoption', 'released']) {
    const current = fixture();
    const boot = { value: 'aeaeaeae-aeae-aeae-aeae-aeaeaeaeaeae' };
    const dependencies = portableDependencies(boot);
    const specification = request(current.lockDirectory);
    try {
      const capability = acquireStagingCutoverHostLock({
        ...specification, ...dependencies, ownerPid: process.pid,
      });
      let target;
      let action;
      if (state === 'canonical') {
        target = current.lockDirectory;
        action = () => verifyStagingCutoverHostLock(capability, {
          ...dependencies, ownerPid: process.pid,
        });
      } else if (state === 'adoption') {
        boot.value = 'afafafaf-afaf-afaf-afaf-afafafafafaf';
        target = `${current.lockDirectory}.claim-${capability.claimSha256}.preparing`;
        fs.mkdirSync(target, { mode: 0o700 });
        action = () => acquireStagingCutoverHostLock({
          ...specification, ...dependencies, ownerPid: process.pid,
        });
      } else {
        releaseStagingCutoverHostLock(capability, {
          ...dependencies, ownerPid: process.pid,
        });
        target = `${current.lockDirectory}.released.tombstone`;
        action = () => acquireStagingCutoverHostLock({
          ...specification, ...dependencies, ownerPid: process.pid,
        });
      }
      for (let index = 0; index < 40; index += 1) {
        fs.writeFileSync(path.join(target, `foreign-${index}`), 'foreign', { mode: 0o600 });
      }
      const before = fs.readdirSync(target).sort();
      assert.throws(action, /entry bound/u, state);
      assert.deepEqual(fs.readdirSync(target).sort(), before, state);
    } finally {
      fs.rmSync(current.root, { force: true, recursive: true });
    }
  }
});

test('fresh process recovers every initial atomic-publication boundary', {
  skip: !LINUX,
}, () => {
  for (const phase of [
    'after-prepared-directory',
    'after-prepared-record',
    'after-published-directory',
  ]) {
    const current = fixture();
    try {
      const specification = request(current.lockDirectory);
      assertKilled(runPhaseWorker(specification, phase));
      acquireAndRelease(specification);
      assertBoundedParentState(current.root);
    } finally {
      fs.rmSync(current.root, { force: true, recursive: true });
    }
  }
});

test('fresh process recovers every dead-owner adoption boundary', {
  skip: !LINUX,
}, () => {
  for (const phase of [
    'after-adoption-prepared',
    'after-adoption-linked',
    'after-adoption-source-cleanup',
    'after-adoption-durable',
  ]) {
    const current = fixture();
    try {
      const specification = request(current.lockDirectory);
      assert.equal(runPhaseWorker(specification).status, 0);
      assertKilled(runPhaseWorker(specification, phase));
      acquireAndRelease(specification);
      assertBoundedParentState(current.root);
    } finally {
      fs.rmSync(current.root, { force: true, recursive: true });
    }
  }
});

test('release rename is resumable and its terminal namespace stays bounded', {
  skip: !LINUX,
}, () => {
  const current = fixture();
  try {
    const specification = request(current.lockDirectory);
    assertKilled(runPhaseWorker(specification, 'after-released-directory', 'release'));
    for (let iteration = 0; iteration < 5; iteration += 1) {
      acquireAndRelease(specification);
      assertBoundedParentState(current.root);
    }
    assert.deepEqual(fs.readdirSync(current.root).length, 1);
  } finally {
    fs.rmSync(current.root, { force: true, recursive: true });
  }
});

test('live owner excludes a second process with status 75', {
  skip: !LINUX,
}, async () => {
  const current = fixture();
  const specification = request(current.lockDirectory);
  const child = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    LIVE_WORKER,
    MODULE_URL,
    JSON.stringify(specification),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await waitForLine(child.stdout);
    assert.throws(
      () => acquireStagingCutoverHostLock({ ...specification, ownerPid: process.pid }),
      (error) => error?.code === 'HOST_OPERATION_LOCKED' && error?.exitCode === 75,
    );
  } finally {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    fs.rmSync(current.root, { force: true, recursive: true });
  }
});

test('journal drift, malformed state, and replaced inode fail closed', {
  skip: !LINUX,
}, () => {
  const current = fixture();
  try {
    const specification = request(current.lockDirectory);
    const capability = acquireStagingCutoverHostLock({
      ...specification,
      ownerPid: process.pid,
    });
    assert.throws(() => acquireStagingCutoverHostLock({
      ...specification,
      legacyMarkerSha256: SHA('6'),
      ownerPid: process.pid,
    }), /another journal/u);

    const displaced = `${current.lockDirectory}.foreign`;
    fs.renameSync(current.lockDirectory, displaced);
    fs.mkdirSync(current.lockDirectory, { mode: 0o700 });
    fs.copyFileSync(path.join(displaced, path.basename(capability.claimPath)),
      path.join(current.lockDirectory, 'owner.json'));
    fs.chmodSync(path.join(current.lockDirectory, 'owner.json'), 0o600);
    assert.throws(
      () => verifyStagingCutoverHostLock(capability, { ownerPid: process.pid }),
      /directory identity|capability is no longer current/u,
    );
    fs.writeFileSync(path.join(current.lockDirectory, 'owner.json'), '{broken}\n', {
      mode: 0o600,
    });
    assert.throws(
      () => acquireStagingCutoverHostLock({ ...specification, ownerPid: process.pid }),
      /not JSON|record is invalid/u,
    );
  } finally {
    fs.rmSync(current.root, { force: true, recursive: true });
  }
});

test('deterministic private sibling with foreign content fails closed', {
  skip: !LINUX,
}, () => {
  const current = fixture();
  try {
    const specification = request(current.lockDirectory);
    assertKilled(runPhaseWorker(specification, 'after-prepared-directory'));
    const [candidate] = fs.readdirSync(current.root);
    fs.writeFileSync(path.join(current.root, candidate, 'foreign'), 'foreign', { mode: 0o600 });
    assert.throws(
      () => acquireStagingCutoverHostLock({ ...specification, ownerPid: process.pid }),
      /foreign state/u,
    );
  } finally {
    fs.rmSync(current.root, { force: true, recursive: true });
  }
});

test('CLI keeps one explicit long-lived owner across isolated bounded subprocesses', {
  skip: !LINUX,
}, () => {
  const current = fixture();
  try {
    const acquire = runWrappedCli([
      'acquire',
      current.lockDirectory,
      String(process.pid),
      path.join(current.root, 'staging-app'),
      BASE.nonce,
      BASE.bridgeSha256,
      BASE.legacyMarkerSha256,
      BASE.legacyComposeSha256,
      BASE.legacyAppMode,
      BASE.legacyMarkerMode,
      BASE.legacyComposeMode,
      BASE.legacyAuthoritySha256,
      BASE.bundleSha256,
    ]);
    assert.equal(acquire.status, 0, acquire.stderr);
    const capability = acquire.stdout.trim();
    const verify = runWrappedCli(['verify', String(process.pid), capability]);
    assert.equal(verify.status, 0, verify.stderr);
    assert.equal(verify.stdout, 'verified\n');
    const release = runWrappedCli(['release', String(process.pid), capability]);
    assert.equal(release.status, 0, release.stderr);
    assert.equal(release.stdout, 'released\n');
  } finally {
    fs.rmSync(current.root, { force: true, recursive: true });
  }
});

test('unrelated same-user live PID cannot be forged as the CLI owner', {
  skip: !LINUX,
}, async () => {
  const current = fixture();
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  try {
    const result = runWrappedCli([
      'acquire',
      current.lockDirectory,
      String(unrelated.pid),
      path.join(current.root, 'staging-app'),
      BASE.nonce,
      BASE.bridgeSha256,
      BASE.legacyMarkerSha256,
      BASE.legacyComposeSha256,
      BASE.legacyAppMode,
      BASE.legacyMarkerMode,
      BASE.legacyComposeMode,
      BASE.legacyAuthoritySha256,
      BASE.bundleSha256,
    ]);
    assert.equal(result.status, 70);
    assert.match(result.stderr, /not a bounded caller ancestor|caller ancestry is not owned/u);
  } finally {
    unrelated.kill('SIGKILL');
    await new Promise((resolve) => unrelated.once('exit', resolve));
    fs.rmSync(current.root, { force: true, recursive: true });
  }
});
