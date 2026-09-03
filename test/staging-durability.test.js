import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

const gitBash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
const commonShell = path.resolve('scripts/staging-release-common.sh');

function posixPath(value) {
  return value.replace(/^([A-Za-z]):/u, (_, drive) => `/${drive.toLowerCase()}`)
    .replaceAll('\\', '/');
}

test('active staging marker never reports publication when parent-directory durability is unproven',
  async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-staging-marker-durability-'));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const script = String.raw`
set -uo pipefail
source "$COMMON_SHELL"
app_dir="$MARKER_ROOT"
bounded_stream_tool=durability-tool
run_bounded() { shift; "$@"; }
reverify_protected_runtime_identity() { :; }
reverify_active_marker_identity() { :; }
capture_active_marker_identity() { printf 'CAPTURE\n'; }
node() {
  if [ "$1" = "$bounded_stream_tool" ]; then
    case "$2" in
      fsync-file) printf 'FILE-SYNC\n'; return 0 ;;
      fsync-parent) printf 'PARENT-SYNC\n'; return 73 ;;
    esac
  fi
  command node "$@"
}
mv() { printf 'MOVE\n'; command mv "$@"; }
if publish_active_marker "\${SHA}"; then status=0; else status=$?; fi
printf 'STATUS:%s\n' "$status"
`;
    const result = spawnSync(gitBash, ['--noprofile', '--norc', '-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        COMMON_SHELL: posixPath(commonShell),
        MARKER_ROOT: posixPath(root),
        SHA: 'a'.repeat(64),
      },
      timeout: 10_000,
    });
    if (result.error?.code === 'ENOENT') return context.skip('Git Bash is not installed');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/u), [
      'FILE-SYNC',
      'MOVE',
      'PARENT-SYNC',
      'STATUS:1',
    ]);
  });

test('release-pair publication stops before private cleanup when its hard link is not durable',
  async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-staging-publication-durability-'));
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const temporary = path.join(root, 'release.tmp');
    const final = path.join(root, 'release.tar.gz');
    await fs.writeFile(temporary, 'candidate archive');
    const script = String.raw`
set -uo pipefail
source "$COMMON_SHELL"
bounded_stream_tool=durability-tool
run_bounded() { shift; "$@"; }
node() {
  if [ "$1" = "$bounded_stream_tool" ]; then
    case "$2" in
      fsync-file) printf 'FILE-SYNC\n'; return 0 ;;
      fsync-parent) printf 'PARENT-SYNC\n'; return 73 ;;
    esac
  fi
  command node "$@"
}
ln() { printf 'LINK\n'; command ln "$@"; }
rm() { printf 'REMOVE\n'; command rm "$@"; }
if publish_owned_publication_path "$TEMPORARY" "$FINAL" "1:2:3:4:5:600:1" 'test publication'; then status=0; else status=$?; fi
printf 'STATUS:%s TEMP:%s FINAL:%s\n' "$status" "$([ -e "$TEMPORARY" ] && printf present || printf absent)" "$([ -e "$FINAL" ] && printf present || printf absent)"
`;
    const result = spawnSync(gitBash, ['--noprofile', '--norc', '-c', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        COMMON_SHELL: posixPath(commonShell),
        TEMPORARY: posixPath(temporary),
        FINAL: posixPath(final),
      },
      timeout: 10_000,
    });
    if (result.error?.code === 'ENOENT') return context.skip('Git Bash is not installed');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/u), [
      'FILE-SYNC',
      'LINK',
      'PARENT-SYNC',
      'STATUS:1 TEMP:present FINAL:present',
    ]);
  });

test('transaction-marker cleanup retries absence durability but preserves its first sync failure', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-staging-cleanup-durability-'));
  const marker = path.join(root, '.staging-recovery-required');
  await fs.writeFile(marker, 'release transaction in progress\n');
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = String.raw`
set -uo pipefail
source "$COMMON_SHELL"
recovery_marker="$MARKER"
bounded_stream_tool=durability-tool
run_bounded() { shift; "$@"; }
reverify_transaction_marker_identity() { :; }
capture_transaction_marker_identity() { printf 'CAPTURE\n'; }
node() {
  if [ "$1" = "$bounded_stream_tool" ] && [ "$2" = fsync-parent ]; then
    printf 'PARENT-SYNC\n'
    return 73
  fi
  command node "$@"
}
rm() { printf 'REMOVE\n'; command rm "$@"; }
if clear_transaction_marker; then status=0; else status=$?; fi
printf 'STATUS:%s MARKER:%s\n' "$status" "$([ -e "$MARKER" ] && printf present || printf absent)"
`;
  const result = spawnSync(gitBash, ['--noprofile', '--norc', '-c', script], {
    encoding: 'utf8',
    env: { ...process.env, COMMON_SHELL: posixPath(commonShell), MARKER: posixPath(marker) },
    timeout: 10_000,
  });
  if (result.error?.code === 'ENOENT') return context.skip('Git Bash is not installed');
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/u), [
    'REMOVE',
    'PARENT-SYNC',
    'PARENT-SYNC',
    'STATUS:73 MARKER:absent',
  ]);
});

test('transaction-marker cleanup recaptures a durably proven absence without hiding failure',
  async (context) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easyboost-staging-cleanup-reconcile-'));
    const marker = path.join(root, '.staging-recovery-required');
    await fs.writeFile(marker, 'release transaction in progress\n');
    context.after(() => fs.rm(root, { recursive: true, force: true }));
    const script = String.raw`
set -uo pipefail
source "$COMMON_SHELL"
recovery_marker="$MARKER"
bounded_stream_tool=durability-tool
parent_sync_attempts=0
run_bounded() { shift; "$@"; }
reverify_transaction_marker_identity() { :; }
capture_transaction_marker_identity() { printf 'CAPTURE\n'; }
node() {
  if [ "$1" = "$bounded_stream_tool" ] && [ "$2" = fsync-parent ]; then
    parent_sync_attempts=$((parent_sync_attempts + 1))
    printf 'PARENT-SYNC:%s\n' "$parent_sync_attempts"
    [ "$parent_sync_attempts" -gt 1 ]
    return
  fi
  command node "$@"
}
rm() { printf 'REMOVE\n'; command rm "$@"; }
if clear_transaction_marker; then status=0; else status=$?; fi
printf 'STATUS:%s MARKER:%s\n' "$status" "$([ -e "$MARKER" ] && printf present || printf absent)"
`;
    const result = spawnSync(gitBash, ['--noprofile', '--norc', '-c', script], {
      encoding: 'utf8',
      env: { ...process.env, COMMON_SHELL: posixPath(commonShell), MARKER: posixPath(marker) },
      timeout: 10_000,
    });
    if (result.error?.code === 'ENOENT') return context.skip('Git Bash is not installed');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/u), [
      'REMOVE',
      'PARENT-SYNC:1',
      'PARENT-SYNC:2',
      'CAPTURE',
      'STATUS:1 MARKER:absent',
    ]);
  });
