import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as runtime from '../scripts/staging-runtime-authority.js';

const tool = path.resolve('scripts/staging-runtime-authority.js');
const common = path.resolve('scripts/staging-release-common.sh');
const linux = process.platform === 'linux';
const headroom = 64 * 1024 * 1024;

function fixture(t, { markers = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'easyboost-protected-boundaries-'));
  const identity = fs.lstatSync(root, { bigint: true });
  t.after(() => {
    const current = fs.lstatSync(root, { bigint: true });
    assert.ok(current.isDirectory() && !current.isSymbolicLink());
    assert.equal(current.dev, identity.dev);
    assert.equal(current.ino, identity.ino);
    fs.rmSync(root, { recursive: true });
  });
  const appDirectory = path.join(root, 'app');
  for (const directory of [appDirectory, path.join(appDirectory, 'backups'),
    path.join(appDirectory, 'rollbacks'), path.join(appDirectory, 'rollbacks', 'releases')]) {
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  const recoveryMarker = path.join(appDirectory, '.staging-recovery-required');
  const activeMarker = path.join(appDirectory, '.release-sha256');
  for (const [file, value] of [
    [path.join(appDirectory, '.env.staging'), 'APP_PORT=3001\n'],
    [path.join(appDirectory, '.staging-release.lock'), ''],
    ...(markers ? [[activeMarker, `${'a'.repeat(64)}\n`], [recoveryMarker, 'transaction\n']] : []),
  ]) {
    fs.writeFileSync(file, value, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }
  return {
    root, appDirectory, activeMarker, recoveryMarker,
    runtimeAuthority: JSON.stringify(runtime.captureProtectedRuntime({ appDirectory })),
    activeMarkerAuthority: JSON.stringify(runtime.captureOptionalPrivateFile({
      file: activeMarker, role: 'active release marker', maximumBytes: 65,
    })),
    transactionMarkerAuthority: JSON.stringify(runtime.captureOptionalPrivateFile({
      file: recoveryMarker, role: 'staging transaction marker', maximumBytes: 4096,
    })),
  };
}

function cli(command, args) {
  return spawnSync(process.execPath, [tool, command, ...args], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 4096,
  });
}

function composeArgs(value) {
  return [value.appDirectory, value.recoveryMarker, value.runtimeAuthority,
    value.activeMarkerAuthority, value.transactionMarkerAuthority];
}

test('Compose authority reproof accepts real runtime and present or absent markers silently', (t) => {
  for (const markers of [true, false]) {
    const value = fixture(t, { markers });
    assert.equal(runtime.verifyComposeAuthority(value), undefined);
    const result = cli('verify-compose-authority', composeArgs(value));
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});

test('Compose reproof reports runtime then active then transaction failures in that order', (t) => {
  const value = fixture(t);
  for (const field of ['runtimeAuthority', 'activeMarkerAuthority', 'transactionMarkerAuthority']) {
    for (const invalid of ['', '{', 'null', '{}']) {
      assert.throws(() => runtime.verifyComposeAuthority({ ...value, [field]: invalid }),
        /invalid|changed/u);
    }
  }
  fs.writeFileSync(path.join(value.appDirectory, '.env.staging'), 'APP_PORT=3002\n');
  const result = cli('verify-compose-authority', composeArgs({ ...value,
    activeMarkerAuthority: '{', transactionMarkerAuthority: '{' }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /protected staging runtime authority changed/u);
  value.runtimeAuthority = JSON.stringify(runtime.captureProtectedRuntime(value));
  fs.writeFileSync(value.activeMarker, `${'b'.repeat(64)}\n`);
  assert.throws(() => runtime.verifyComposeAuthority({ ...value, transactionMarkerAuthority: '{' }),
    /active release marker.*changed/u);
  value.activeMarkerAuthority = JSON.stringify(runtime.captureOptionalPrivateFile({
    file: value.activeMarker, role: 'active release marker', maximumBytes: 65,
  }));
  fs.writeFileSync(value.recoveryMarker, 'changed transaction\n');
  assert.throws(() => runtime.verifyComposeAuthority(value), /staging transaction marker.*changed/u);
});

for (const marker of ['activeMarker', 'recoveryMarker']) {
  test(`Compose reproof detects ${marker} presence, type, link and identity changes`, (t) => {
    const value = fixture(t, { markers: false });
    const file = value[marker];
    fs.writeFileSync(file, 'marker\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    assert.throws(() => runtime.verifyComposeAuthority(value), /presence.*changed/u);
    const capture = () => JSON.stringify(runtime.captureOptionalPrivateFile({
      file, role: marker, maximumBytes: marker === 'activeMarker' ? 65 : 4096,
    }));
    value[marker === 'activeMarker' ? 'activeMarkerAuthority' : 'transactionMarkerAuthority'] = capture();
    const saved = `${file}.saved`;
    fs.renameSync(file, saved);
    fs.copyFileSync(saved, file);
    fs.chmodSync(file, 0o600);
    assert.throws(() => runtime.verifyComposeAuthority(value), /identity.*changed/u);
    fs.unlinkSync(file);
    fs.linkSync(saved, file);
    assert.throws(() => runtime.verifyComposeAuthority(value), /single-link/u);
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    assert.throws(() => runtime.verifyComposeAuthority(value), /regular no-follow/u);
    fs.rmdirSync(file);
    if (process.platform !== 'win32') {
      fs.symlinkSync(saved, file);
      assert.throws(() => runtime.verifyComposeAuthority(value), /regular no-follow/u);
      fs.unlinkSync(file);
      fs.renameSync(saved, file);
      fs.chmodSync(file, 0o644);
      assert.throws(() => runtime.verifyComposeAuthority(value), /exact private owner and mode/u);
    }
  });
}

function shell(value, body, extraEnv = {}) {
  const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', [
    'source "$1" || exit',
    'app_dir="$PB_APP"; recovery_marker="$PB_RECOVERY"',
    'protected_runtime_identity="$PB_RUNTIME"; active_marker_authority="$PB_ACTIVE"',
    'transaction_marker_authority="$PB_TRANSACTION"',
    'work_dir="${PB_WORK:-}"; work_dir_identity="${PB_WORK_ID:-}"',
    'temporary_reservation_file="${PB_TEMP:-}"; temporary_reservation_authority="${PB_TEMP_ID:-}"',
    'live_reservation_file="${PB_LIVE:-}"; live_reservation_authority="${PB_LIVE_ID:-}"',
    'store_reservation_file="${PB_STORE:-}"; store_reservation_authority="${PB_STORE_ID:-}"',
    body,
  ].join('\n'), 'protected-boundaries-test', common], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 8192,
    env: {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: 'C',
      PB_APP: value.appDirectory, PB_RECOVERY: value.recoveryMarker,
      PB_RUNTIME: value.runtimeAuthority, PB_ACTIVE: value.activeMarkerAuthority,
      PB_TRANSACTION: value.transactionMarkerAuthority, ...extraEnv,
    },
  });
  assert.equal(result.error, undefined);
  return result;
}

const realBounded = 'run_bounded() { printf "%s:%s\\n" "$1" "$4" >> "$PB_TRACE"; shift; "$@"; }';

test('shell Compose reproof uses one 60-second real CLI call for populated captures', {
  skip: !linux,
}, (t) => {
  const value = fixture(t);
  const trace = path.join(value.root, 'trace');
  const result = shell(value, `${realBounded}\nreverify_compose_authority`, { PB_TRACE: trace });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(fs.readFileSync(trace, 'utf8'), '60:verify-compose-authority\n');
});

function workspace(value) {
  const workDirectory = path.join(value.appDirectory, 'rollbacks', 'workspace');
  fs.mkdirSync(workDirectory, { mode: 0o700 });
  fs.chmodSync(workDirectory, 0o700);
  const stat = spawnSync('stat', ['-c', '%d:%i:%f:%u:%g:%a', '--', workDirectory], {
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(stat.status, 0, stat.stderr);
  return { ...value, workDirectory, workspaceIdentity: stat.stdout.trim() };
}

function workspaceArgs(value) {
  return [value.appDirectory, value.runtimeAuthority, value.workDirectory, value.workspaceIdentity];
}

test('Linux workspace reproof accepts the exact actual GNU stat record without recapturing it', {
  skip: !linux,
}, (t) => {
  const value = workspace(fixture(t));
  assert.equal(runtime.verifyReleaseWorkspace(value), undefined);
  const result = cli('verify-release-workspace', workspaceArgs(value));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  fs.mkdirSync(path.join(value.workDirectory, 'candidate'));
  assert.equal(runtime.verifyReleaseWorkspace(value), undefined,
    'intentional workspace contents do not change the captured root identity');
});

test('GNU workspace identity interpretation is refused on non-Linux runtimes', {
  skip: linux,
}, (t) => {
  const value = fixture(t);
  assert.throws(() => runtime.verifyReleaseWorkspace({ ...value,
    workDirectory: path.join(value.appDirectory, 'rollbacks', 'workspace'),
    workspaceIdentity: '1:2:41c0:0:0:700',
  }), /Linux/u);
});

test('workspace record equality covers every GNU field and rejects special permissions', {
  skip: !linux,
}, (t) => {
  const value = workspace(fixture(t));
  for (let index = 0; index < 6; index += 1) {
    const fields = value.workspaceIdentity.split(':');
    fields[index] = index === 2 ? '41c1' : '99999999999999999999';
    assert.throws(() => runtime.verifyReleaseWorkspace({ ...value,
      workspaceIdentity: fields.join(':'),
    }), /workspace identity changed/u);
  }
  for (const mode of [0o755, 0o1700, 0o2700, 0o4700]) {
    fs.chmodSync(value.workDirectory, mode);
    const record = spawnSync('stat', ['-c', '%d:%i:%f:%u:%g:%a', '--', value.workDirectory], {
      encoding: 'utf8', timeout: 5000,
    });
    assert.equal(record.status, 0, record.stderr);
    assert.equal(record.stdout.trim().split(':').at(-1), mode.toString(8));
    assert.throws(() => runtime.verifyReleaseWorkspace({ ...value,
      workspaceIdentity: record.stdout.trim(),
    }), /workspace identity changed/u, 'even a freshly matching special-mode record is unsafe');
  }
});

test('workspace reproof refuses replacement, linked or wrong parent paths and proves runtime first', {
  skip: !linux,
}, (t) => {
  const value = workspace(fixture(t));
  for (const workDirectory of ['', path.dirname(value.workDirectory),
    path.join(value.appDirectory, 'backups'), `${value.workDirectory}/../workspace`]) {
    assert.throws(() => runtime.verifyReleaseWorkspace({ ...value, workDirectory }),
      /workspace identity changed/u);
  }
  for (const workspaceIdentity of ['', 'invalid', value.workspaceIdentity + ':extra']) {
    assert.throws(() => runtime.verifyReleaseWorkspace({ ...value, workspaceIdentity }),
      /workspace identity changed/u);
  }
  fs.renameSync(value.workDirectory, `${value.workDirectory}.saved`);
  fs.mkdirSync(value.workDirectory, { mode: 0o700 });
  assert.throws(() => runtime.verifyReleaseWorkspace(value), /workspace identity changed/u);
  fs.rmdirSync(value.workDirectory);
  assert.throws(() => runtime.verifyReleaseWorkspace(value), /workspace identity changed/u);
  fs.symlinkSync(`${value.workDirectory}.saved`, value.workDirectory);
  assert.throws(() => runtime.verifyReleaseWorkspace(value), /workspace identity changed/u);
  fs.unlinkSync(value.workDirectory);
  fs.writeFileSync(value.workDirectory, 'file', { mode: 0o700 });
  assert.throws(() => runtime.verifyReleaseWorkspace(value), /workspace identity changed/u);
  fs.writeFileSync(path.join(value.appDirectory, '.env.staging'), 'changed\n');
  assert.throws(() => runtime.verifyReleaseWorkspace({ ...value, workspaceIdentity: '' }),
    /protected staging runtime authority changed/u);
});

test('shell Linux workspace reproof uses one 60-second real CLI call and retains non-Linux fallback', {
  skip: !linux,
}, (t) => {
  const value = workspace(fixture(t));
  const trace = path.join(value.root, 'trace');
  const environment = { PB_TRACE: trace, PB_WORK: value.workDirectory,
    PB_WORK_ID: value.workspaceIdentity };
  let result = shell(value, `${realBounded}\nreverify_release_workspace`, environment);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(trace, 'utf8'), '60:verify-release-workspace\n');
  fs.unlinkSync(trace);
  result = shell(value, `${realBounded}\nOSTYPE=msys\nreverify_release_workspace`, environment);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(trace, 'utf8'), '60:verify-runtime\n60:%d:%i:%f:%u:%g:%a\n');
});

function reservation(value, name) {
  const file = path.join(value.root, name);
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    for (let bytes = 0; bytes < headroom; bytes += chunk.length) fs.writeSync(descriptor, chunk);
  } finally { fs.closeSync(descriptor); }
  fs.chmodSync(file, 0o600);
  return { file, authority: JSON.stringify(runtime.captureReservation({ file, minimumBytes: headroom })) };
}

function reservations(value) {
  const result = { ...value };
  for (const slot of ['temporary', 'live', 'store']) {
    const { file, authority } = reservation(value, `${slot}.reservation`);
    result[`${slot}File`] = file;
    result[`${slot}Authority`] = authority;
  }
  return result;
}

function reservationArgs(value) {
  return ['temporary', 'live', 'store'].flatMap((slot) =>
    [value[`${slot}File`] ?? '', value[`${slot}Authority`] ?? '']);
}

test('reservation reproof validates three real allocated slots and skips empty slots', (t) => {
  const value = reservations(fixture(t));
  assert.equal(runtime.verifySpaceReservations(value), undefined);
  const result = cli('verify-space-reservations', reservationArgs(value));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(runtime.verifySpaceReservations({
    temporaryFile: '', temporaryAuthority: '{', liveFile: '', liveAuthority: '{',
    storeFile: value.storeFile, storeAuthority: value.storeAuthority,
  }), undefined);
  assert.equal(runtime.verifySpaceReservations({}), undefined);
});

test('reservation reproof retains first-match association for duplicate paths', (t) => {
  const value = fixture(t);
  const { file, authority } = reservation(value, 'shared');
  assert.equal(runtime.verifySpaceReservations({
    temporaryFile: file, temporaryAuthority: authority, liveFile: file, liveAuthority: '{',
    storeFile: file, storeAuthority: '',
  }), undefined);
  assert.equal(runtime.verifySpaceReservations({
    temporaryFile: '', temporaryAuthority: '{', liveFile: file, liveAuthority: authority,
    storeFile: file, storeAuthority: '{',
  }), undefined);
  assert.throws(() => runtime.verifySpaceReservations({
    temporaryFile: file, temporaryAuthority: '', liveFile: file, liveAuthority: authority,
  }), /reservation authority is invalid/u);
});

test('reservation reproof rejects malformed captures, unsafe capacities and exact JSON drift', (t) => {
  const value = fixture(t);
  const { file, authority } = reservation(value, 'reservation');
  const check = (capture) => runtime.verifySpaceReservations({ temporaryFile: file,
    temporaryAuthority: capture });
  for (const capture of ['', '{', 'null', '{}', '[]']) {
    assert.throws(() => check(capture), /invalid|headroom/u);
  }
  const parsed = JSON.parse(authority);
  for (const size of ['', 'abc', 'NaN', 'Infinity', '-1', '1.5', '1e9', ' 67108864',
    '0x4000000', '9007199254740992', '67108863', 67108864, null, [], {}]) {
    assert.throws(() => check(JSON.stringify({ ...parsed, size })), /invalid|headroom/u);
  }
  for (const field of ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'blocks', 'allocatedBytes']) {
    assert.throws(() => check(JSON.stringify({ ...parsed, [field]: 'changed' })),
      /identity or allocated capacity changed/u);
  }
  assert.throws(() => check(JSON.stringify({ ...parsed, extra: true })), /identity.*changed/u);
  assert.throws(() => check(JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse()))),
    /identity.*changed/u);
  fs.truncateSync(file, headroom - 1);
  assert.throws(() => check(authority), /allocated capacity/u);
});

test('reservation reproof preserves slot order and rejects hardlinks, replacement and wrong types', (t) => {
  const value = fixture(t);
  const { file, authority } = reservation(value, 'reservation');
  const check = () => runtime.verifySpaceReservations({ temporaryFile: file,
    temporaryAuthority: authority, liveFile: 'later-missing', liveAuthority: '{' });
  fs.linkSync(file, `${file}.saved`);
  assert.throws(check, /single-link/u, 'earlier file proof precedes later JSON parsing');
  fs.unlinkSync(file);
  fs.copyFileSync(`${file}.saved`, file);
  fs.chmodSync(file, 0o600);
  assert.throws(check, /identity.*changed/u);
  fs.unlinkSync(file);
  assert.throws(check, /missing or unreadable/u);
  fs.mkdirSync(file);
  assert.throws(check, /regular no-follow/u);
  fs.rmdirSync(file);
  if (process.platform !== 'win32') {
    fs.symlinkSync(`${file}.saved`, file);
    assert.throws(check, /regular no-follow/u);
    fs.unlinkSync(file);
    fs.renameSync(`${file}.saved`, file);
    fs.chmodSync(file, 0o644);
    assert.throws(check, /exact private owner and mode/u);
  }
});

test('reservation reproof requires actual allocated blocks despite unchanged logical size', {
  skip: !linux,
}, (t) => {
  const value = fixture(t);
  const { file, authority } = reservation(value, 'reservation');
  fs.truncateSync(file, 0);
  fs.truncateSync(file, headroom);
  assert.ok(fs.statSync(file).blocks * 512 < headroom, 'real sparse replacement of allocated capacity');
  assert.throws(() => runtime.verifySpaceReservations({ temporaryFile: file,
    temporaryAuthority: authority }), /allocated capacity could not be proven/u);
});

function workspaceEnvironment(value) {
  return { PB_WORK: value.workDirectory, PB_WORK_ID: value.workspaceIdentity };
}

function reservationEnvironment(value) {
  return { ...workspaceEnvironment(value),
    PB_TEMP: value.temporaryFile ?? '', PB_TEMP_ID: value.temporaryAuthority ?? '',
    PB_LIVE: value.liveFile ?? '', PB_LIVE_ID: value.liveAuthority ?? '',
    PB_STORE: value.storeFile ?? '', PB_STORE_ID: value.storeAuthority ?? '',
  };
}

test('shell reservation reproof retains workspace proof then one 60-second real reservation CLI', {
  skip: !linux,
}, (t) => {
  const value = reservations(workspace(fixture(t)));
  const trace = path.join(value.root, 'trace');
  const result = shell(value, `${realBounded}\nverify_space_reservations`, {
    ...reservationEnvironment(value), PB_TRACE: trace,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(fs.readFileSync(trace, 'utf8'),
    '60:verify-release-workspace\n60:verify-space-reservations\n');
});

const finiteFailure = [
  'run_bounded() {',
  '  printf "%s:%s\\n" "$1" "$4" >> "$PB_TRACE"',
  '  if [ "$4" = "$PB_FAIL_OPERATION" ]; then',
  '    node -e "process.exitCode = Number(process.env.PB_FAIL_STATUS)"',
  '  else shift; "$@"; fi',
  '}',
].join('\n');

function observedCall(command) {
  return `${command}; status=$?; printf '%s:%s\\n' "$status" "$authority_violation"`;
}

test('shell composed proofs fail closed for finite guard statuses with unchanged authority flags', {
  skip: !linux,
}, (t) => {
  const value = reservations(workspace(fixture(t)));
  const trace = path.join(value.root, 'trace');
  const cases = [
    ['reverify_compose_authority', 'verify-compose-authority', 1],
    ['reverify_release_workspace', 'verify-release-workspace', 1],
    ['verify_space_reservations', 'verify-release-workspace', 1],
    ['verify_space_reservations', 'verify-space-reservations', 0],
  ];
  for (const status of [1, 23, 124, 125, 137]) {
    for (const [command, operation, expectedFlag] of cases) {
      fs.writeFileSync(trace, '');
      const result = shell(value, `${finiteFailure}\n${observedCall(command)}`, {
        ...reservationEnvironment(value), PB_TRACE: trace,
        PB_FAIL_OPERATION: operation, PB_FAIL_STATUS: String(status),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `1:${expectedFlag}\n`, `${command} guard ${status}`);
      const expectedCalls = operation === 'verify-space-reservations'
        ? '60:verify-release-workspace\n60:verify-space-reservations\n' : `60:${operation}\n`;
      assert.equal(fs.readFileSync(trace, 'utf8'), expectedCalls);
    }
  }
  const result = shell(value,
    `${finiteFailure}\nauthority_violation=1\n${observedCall('verify_space_reservations')}`, {
      ...reservationEnvironment(value), PB_TRACE: trace,
      PB_FAIL_OPERATION: 'verify-space-reservations', PB_FAIL_STATUS: '23',
    });
  assert.equal(result.stdout, '1:1\n', 'reservation refusal must not erase a prior authority flag');
});

test('shell missing captures preserve their original first-failure authority flag ordering', {
  skip: !linux,
}, (t) => {
  const value = workspace(fixture(t));
  const trace = path.join(value.root, 'trace');
  const cases = [
    ['reverify_compose_authority', { PB_RUNTIME: '' }, '', 0],
    ['reverify_compose_authority', { PB_ACTIVE: '' }, '60:verify-runtime\n', 0],
    ['reverify_compose_authority', { PB_TRANSACTION: '' },
      '60:verify-runtime\n60:verify-optional-file\n', 0],
    ['reverify_release_workspace', { PB_RUNTIME: '', PB_WORK_ID: '' }, '', 0],
    ['reverify_release_workspace', { PB_WORK_ID: '' }, '60:verify-runtime\n', 1],
    ['reverify_release_workspace', { PB_WORK: value.root }, '60:verify-runtime\n', 1],
  ];
  for (const [command, environment, expectedTrace, flag] of cases) {
    fs.writeFileSync(trace, '');
    const result = shell(value, `${realBounded}\n${observedCall(command)}`, {
      ...workspaceEnvironment(value), PB_TRACE: trace, ...environment,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `1:${flag}\n`);
    assert.equal(fs.readFileSync(trace, 'utf8'), expectedTrace);
  }
  fs.writeFileSync(value.activeMarker, `${'b'.repeat(64)}\n`);
  let result = shell(value, `${realBounded}\n${observedCall('reverify_compose_authority')}`, {
    PB_TRACE: trace, PB_TRANSACTION: '',
  });
  assert.equal(result.stdout, '1:1\n', 'earlier active proof failure overrides later empty capture');
  assert.match(result.stderr, /active release marker.*changed/u);
  fs.writeFileSync(path.join(value.appDirectory, '.env.staging'), 'changed\n');
  for (const command of ['reverify_compose_authority', 'reverify_release_workspace']) {
    result = shell(value, `${realBounded}\n${observedCall(command)}`, {
      ...workspaceEnvironment(value), PB_TRACE: trace, PB_ACTIVE: '', PB_WORK: value.root,
    });
    assert.equal(result.stdout, '1:1\n');
    assert.match(result.stderr, /protected staging runtime authority changed/u);
  }
});

test('shell missing-capture fallback retains finite failures at every earlier real proof', {
  skip: !linux,
}, (t) => {
  const value = workspace(fixture(t));
  const trace = path.join(value.root, 'trace');
  for (const status of [1, 23, 124, 125, 137]) {
    for (const [command, operation, environment] of [
      ['reverify_compose_authority', 'verify-runtime', { PB_ACTIVE: '' }],
      ['reverify_compose_authority', 'verify-optional-file', { PB_TRANSACTION: '' }],
      ['reverify_release_workspace', 'verify-runtime', { PB_WORK_ID: '' }],
    ]) {
      const result = shell(value, `${finiteFailure}\n${observedCall(command)}`, {
        ...workspaceEnvironment(value), PB_TRACE: trace, PB_FAIL_OPERATION: operation,
        PB_FAIL_STATUS: String(status), ...environment,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '1:1\n', `${command} ${operation} ${status}`);
    }
  }
});

test('shell empty reservation slots require only the existing workspace proof', {
  skip: !linux,
}, (t) => {
  const value = workspace(fixture(t));
  const trace = path.join(value.root, 'trace');
  const result = shell(value, `${finiteFailure}\n${observedCall('verify_space_reservations')}`, {
    ...workspaceEnvironment(value), PB_TRACE: trace,
    PB_FAIL_OPERATION: 'verify-space-reservations', PB_FAIL_STATUS: '23',
    PB_TEMP_ID: '{', PB_LIVE_ID: '{', PB_STORE_ID: '{',
  });
  assert.equal(result.stdout, '0:0\n');
  assert.equal(fs.readFileSync(trace, 'utf8'), '60:verify-release-workspace\n');
});

test('three fixed-purpose CLI operations reject missing or extra arguments without output', (t) => {
  const value = fixture(t);
  for (const [command, args] of [
    ['verify-compose-authority', composeArgs(value)],
    ['verify-release-workspace', [value.appDirectory, value.runtimeAuthority, '/missing', 'record']],
    ['verify-space-reservations', ['', '', '', '', '', '']],
  ]) {
    for (const invalid of [[], args.slice(0, -1), [...args, 'extra']]) {
      const result = cli(command, invalid);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /Usage/u);
    }
  }
});

test('Compose reproof retains both marker byte bounds and fresh invocation proofs', (t) => {
  for (const [marker, maximumBytes] of [['activeMarker', 65], ['recoveryMarker', 4096]]) {
    const value = fixture(t);
    assert.equal(runtime.verifyComposeAuthority(value), undefined);
    fs.writeFileSync(value[marker], Buffer.alloc(maximumBytes + 1));
    const result = cli('verify-compose-authority', composeArgs(value));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /byte bound/u);
    assert.equal(result.stdout, '');
  }
});

test('shell real reservation-only refusal retains its flag while workspace refusal sets it', {
  skip: !linux,
}, (t) => {
  const value = workspace(fixture(t));
  const { file, authority } = reservation(value, 'reservation');
  value.temporaryFile = file;
  value.temporaryAuthority = authority;
  const environment = { ...reservationEnvironment(value), PB_TRACE: path.join(value.root, 'trace') };
  fs.truncateSync(file, headroom - 1);
  let result = shell(value, `${realBounded}\n${observedCall('verify_space_reservations')}`, environment);
  assert.equal(result.stdout, '1:0\n');
  assert.match(result.stderr, /allocated capacity/u);
  fs.chmodSync(value.workDirectory, 0o755);
  result = shell(value, `${realBounded}\n${observedCall('verify_space_reservations')}`, environment);
  assert.equal(result.stdout, '1:1\n');
  assert.match(result.stderr, /workspace identity changed/u);
});

test('foreign-owner protected proofs reject actual owner changes in disposable private fixtures', {
  skip: !linux || process.getuid() !== 0,
}, (t) => {
  for (const kind of ['runtime', 'active', 'transaction', 'workspace', 'reservation']) {
    const value = workspace(fixture(t));
    let file;
    let verify;
    if (kind === 'workspace') {
      file = value.workDirectory;
      verify = () => runtime.verifyReleaseWorkspace(value);
    } else if (kind === 'reservation') {
      const allocated = reservation(value, 'reservation');
      file = allocated.file;
      verify = () => runtime.verifySpaceReservations({ temporaryFile: file,
        temporaryAuthority: allocated.authority });
    } else {
      file = kind === 'runtime' ? path.join(value.appDirectory, '.env.staging')
        : kind === 'active' ? value.activeMarker : value.recoveryMarker;
      verify = () => runtime.verifyComposeAuthority(value);
    }
    const relative = path.relative(value.root, file);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert.equal(fs.realpathSync(file), path.resolve(file));
    const before = fs.lstatSync(file, { bigint: true });
    assert.ok(!before.isSymbolicLink() && (before.isDirectory() || before.isFile()));
    assert.equal(before.uid, 0n);
    fs.chownSync(file, 1, 1);
    const changed = fs.lstatSync(file, { bigint: true });
    assert.equal(changed.dev, before.dev);
    assert.equal(changed.ino, before.ino);
    assert.equal(changed.uid, 1n);
    assert.throws(verify, /exact private owner and mode|workspace identity changed/u);
  }
});
