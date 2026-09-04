#!/bin/bash
set -Eeuo pipefail
umask 077
PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
LC_ALL=C
export PATH LC_ALL

PROTOCOL='immutable-archive-v4'
source_dir="$(dirname "$(readlink -f "$0")")"
install_root="${STAGING_HELPER_INSTALL_ROOT:-/usr/local/lib/easyboost-staging-release}"
link_root="${STAGING_HELPER_LINK_ROOT:-/usr/local/sbin}"
app_dir="${STAGING_APP_DIR:-/opt/easyboost-staging}"
host_operation_lock_directory="${EASYBOOST_HOST_OPERATION_LOCK_DIR:-/var/lib/easyboost/locks/host-operation.lock}"
case "$install_root:$link_root:$app_dir:$host_operation_lock_directory" in
  /*:/*:/*:/*) ;;
  *) echo 'Helper installation and staging authority roots must be absolute' >&2; exit 64 ;;
esac
command -v node >/dev/null 2>&1 || { echo 'Node.js is required' >&2; exit 69; }
command -v flock >/dev/null 2>&1 || { echo 'flock is required' >&2; exit 69; }
[ -x /usr/bin/python3 ] || { echo '/usr/bin/python3 is required for atomic renameat2 handoff' >&2; exit 69; }
/usr/bin/python3 -I -S -c '
import ctypes, errno, os, tempfile
root = tempfile.mkdtemp(prefix=".easyboost-renameat2-probe.", dir="/tmp")
libc = ctypes.CDLL(None, use_errno=True)
renameat2 = getattr(libc, "renameat2", None)
if renameat2 is None:
    raise SystemExit(69)
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
def call(source, destination):
    return renameat2(-100, os.fsencode(source), -100, os.fsencode(destination), 1)
source = os.path.join(root, "source")
destination = os.path.join(root, "destination")
late_source = os.path.join(root, "late-source")
late_destination = os.path.join(root, "late-destination")
try:
    os.mkdir(source, 0o700)
    if call(source, destination) != 0 or os.path.exists(source) or not os.path.isdir(destination):
        raise SystemExit(69)
    os.mkdir(late_source, 0o700)
    os.mkdir(late_destination, 0o700)
    ctypes.set_errno(0)
    if call(late_source, late_destination) == 0 or ctypes.get_errno() != errno.EEXIST:
        raise SystemExit(69)
    if not os.path.isdir(late_source) or not os.path.isdir(late_destination):
        raise SystemExit(69)
finally:
    for entry in (source, destination, late_source, late_destination):
        try: os.rmdir(entry)
        except FileNotFoundError: pass
    os.rmdir(root)
' || { echo 'renameat2(RENAME_NOREPLACE) is unavailable on the host /tmp filesystem' >&2; exit 69; }

# Installation mutates the shared generation, launcher and private-Node roots.
# A kernel-held lock serializes separate installer processes and is released by
# the OS after a crash; the file is only a stable lock inode, never a stale
# ownership marker.
installer_uid="$(id -u)"
installer_gid="$(id -g)"
if [ "$installer_uid" = 0 ]; then
  installer_lock_root='/run/lock/easyboost-staging-helper'
else
  # Custom unprivileged installations are used by the hermetic Linux release
  # tests. One private per-user inode still serializes every helper/link root
  # that user can mutate, while production root installations use /run/lock.
  installer_lock_root="/tmp/easyboost-staging-helper-installer.$installer_uid"
fi
mkdir -m 700 -- "$installer_lock_root" 2>/dev/null || true
[ ! -L "$installer_lock_root" ] \
  && [ "$(stat -c '%F:%u:%g:%a' -- "$installer_lock_root")" \
    = "directory:$installer_uid:$installer_gid:700" ] \
  || { echo 'Helper installer lock root is unsafe' >&2; exit 69; }
installer_lock_file="$installer_lock_root/install.lock"
exec 7<> "$installer_lock_file"
chmod 600 -- "/proc/$$/fd/7"
installer_lock_opened="$(stat -Lc '%d:%i:%u:%g:%a:%h:%s' -- "/proc/$$/fd/7")"
installer_lock_current="$(stat -Lc '%d:%i:%u:%g:%a:%h:%s' -- "$installer_lock_file")"
[ ! -L "$installer_lock_file" ] && [ -f "$installer_lock_file" ] \
  && [ "$installer_lock_opened" = "$installer_lock_current" ] \
  && [[ "$installer_lock_opened" == *":$installer_uid:$installer_gid:600:1:0" ]] \
  || { echo 'Helper installer lock file is unsafe' >&2; exit 69; }
flock -n 7 || { echo 'Another staging helper installation is active' >&2; exit 75; }

# Existing launchers and every supervised staging transaction serialize on this
# exact inode as fd 8.  Bind it before asking the bundle installer to inspect or
# replace `current`, the launcher, or any dispatcher.  A pristine first install
# has neither this inode nor a launcher capable of starting a cutover; the bundle
# creates the inode durably before publishing that first launcher/current pair.
maintenance_lock="$install_root/maintenance.lock"
current_pointer="$install_root/current"
maintenance_present=0
[ ! -e "$maintenance_lock" ] && [ ! -L "$maintenance_lock" ] \
  || maintenance_present=1
if [ "$maintenance_present" -eq 1 ]; then
  [ ! -L "$maintenance_lock" ] && [ -f "$maintenance_lock" ] \
    || { echo 'Staging helper maintenance lock is unsafe' >&2; exit 69; }
  maintenance_expected="$(node --input-type=module -e '
    import { createHash } from "node:crypto";
    import path from "node:path";
    const bytes = Buffer.from(`${JSON.stringify({
      installRoot: path.resolve(process.argv[1]),
      protocol: "easyboost-staging-quiescent-maintenance-lock-v1",
    })}\n`);
    process.stdout.write(`${bytes.length} ${createHash("sha256").update(bytes).digest("hex")}\n`);
  ' "$install_root")" || exit 69
  read -r maintenance_expected_size maintenance_expected_digest \
    <<< "$maintenance_expected"
  [[ "$maintenance_expected_size" =~ ^[1-9][0-9]*$ ]] \
    && [[ "$maintenance_expected_digest" =~ ^[a-f0-9]{64}$ ]] \
    || { echo 'Staging helper maintenance lock authority is invalid' >&2; exit 69; }
  maintenance_before="$(stat -Lc '%d:%i:%F:%u:%g:%a:%h:%s' -- "$maintenance_lock")" \
    || exit 69
  [[ "$maintenance_before" == *":regular file:$installer_uid:$installer_gid:600:1:$maintenance_expected_size" ]] \
    || { echo 'Staging helper maintenance lock identity is unsafe' >&2; exit 69; }
  maintenance_digest_output="$(sha256sum -- "$maintenance_lock")" || exit 69
  [ "${maintenance_digest_output%% *}" = "$maintenance_expected_digest" ] \
    || { echo 'Staging helper maintenance lock bytes are not canonical' >&2; exit 69; }
  exec 8<> "$maintenance_lock" || exit 69
  maintenance_opened="$(stat -Lc '%d:%i:%F:%u:%g:%a:%h:%s' -- "/proc/$$/fd/8")" \
    || exit 69
  [ "$maintenance_opened" = "$maintenance_before" ] \
    || { echo 'Staging helper maintenance lock changed while opening' >&2; exit 69; }
  flock -n 8 \
    || { echo 'Another staging helper transaction is active' >&2; exit 75; }
  maintenance_after="$(stat -Lc '%d:%i:%F:%u:%g:%a:%h:%s' -- "$maintenance_lock")" \
    || exit 69
  maintenance_opened_after="$(stat -Lc '%d:%i:%F:%u:%g:%a:%h:%s' -- "/proc/$$/fd/8")" \
    || exit 69
  maintenance_digest_output="$(sha256sum -- "/proc/$$/fd/8")" || exit 69
  [ "$maintenance_after" = "$maintenance_before" ] \
    && [ "$maintenance_opened_after" = "$maintenance_before" ] \
    && [ "${maintenance_digest_output%% *}" = "$maintenance_expected_digest" ] \
    || { echo 'Staging helper maintenance lock changed after acquisition' >&2; exit 69; }
fi

# Inspect installed publication state only after binding fd 8 whenever that
# authority already exists.  The missing-lock case is admissible solely for a
# pristine install with no published current generation.
current_present=0
[ ! -e "$current_pointer" ] && [ ! -L "$current_pointer" ] \
  || current_present=1
if [ "$current_present" -eq 1 ] && [ "$maintenance_present" -ne 1 ]; then
  echo 'Installed staging helper current pointer has no maintenance lock' >&2
  exit 69
fi

# Cutover publishes an exact nonce journal before it mutates staging. A crash
# can leave only its deterministic `.preparing` entry before the final journal
# exists. Inventory the bounded app root and reserve that preparing namespace:
# a canonical entry is active recovery
# state, while a malformed colliding entry must fail closed and remain untouched.
cutover_temporary_scan=''
cutover_temporary_scan_status=0
if cutover_temporary_scan="$(node --input-type=module -e '
  import fs from "node:fs";
  import path from "node:path";
  const root = process.argv[1];
  const reservedPrefix = ".staging-recovery-required.cutover-";
  const reservedSuffix = ".preparing";
  const maximumEntries = 4096;
  const maximumNameBytes = 255;
  const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;
  let rootIdentity;
  try {
    rootIdentity = fs.lstatSync(root, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      process.stdout.write("clear\n");
      process.exit(0);
    }
    throw error;
  }
  if (rootIdentity.isSymbolicLink() || !rootIdentity.isDirectory()) {
    throw new Error("staging app root is not a real directory");
  }
  const owner = typeof process.getuid === "function" ? BigInt(process.getuid()) : null;
  const rootDescriptor = fs.openSync(root,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let result = "clear";
  let entries = 0;
  try {
    const openedRoot = fs.fstatSync(rootDescriptor, { bigint: true });
    const rootAfterOpen = fs.lstatSync(root, { bigint: true });
    if (!openedRoot.isDirectory() || !sameIdentity(rootIdentity, openedRoot)
        || !sameIdentity(openedRoot, rootAfterOpen)) {
      throw new Error("staging app root changed while opening its inventory descriptor");
    }
    const descriptorRoot = `/proc/self/fd/${rootDescriptor}`;
    const directory = fs.opendirSync(descriptorRoot);
    const afterPhase = (_phase) => {};
    try {
      afterPhase("after-root-open");
      for (;;) {
        const entry = directory.readSync();
        if (entry === null) break;
        entries += 1;
        if (entries > maximumEntries) {
          throw new Error("staging app root inventory exceeds its safety bound");
        }
        const nameBytes = Buffer.byteLength(entry.name, "utf8");
        if (nameBytes < 1 || nameBytes > maximumNameBytes) {
          throw new Error("staging app root inventory name exceeds its safety bound");
        }
        if (!entry.name.startsWith(reservedPrefix)) continue;
        if (result !== "clear") result = "unsafe";
        if (!entry.name.endsWith(reservedSuffix)) {
          result = "unsafe";
          continue;
        }
        const nonce = entry.name.slice(
          reservedPrefix.length, entry.name.length - reservedSuffix.length,
        );
        if (!/^[a-f0-9]{64}$/u.test(nonce)) {
          result = "unsafe";
          continue;
        }
        const candidatePath = path.join(descriptorRoot, entry.name);
        const candidateBefore = fs.lstatSync(candidatePath, { bigint: true });
        if (!candidateBefore.isFile() || candidateBefore.isSymbolicLink()) {
          result = "unsafe";
          continue;
        }
        const candidateDescriptor = fs.openSync(candidatePath,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        let candidateOpened;
        try {
          candidateOpened = fs.fstatSync(candidateDescriptor, { bigint: true });
        } finally {
          fs.closeSync(candidateDescriptor);
        }
        const candidateAfter = fs.lstatSync(candidatePath, { bigint: true });
        const safe = candidateOpened.isFile()
          && sameIdentity(candidateBefore, candidateOpened)
          && sameIdentity(candidateOpened, candidateAfter)
          && candidateOpened.nlink === 1n
          && (owner === null || candidateOpened.uid === owner)
          && Number(candidateOpened.mode & 0o777n) === 0o600;
        if (!safe) {
          result = "unsafe";
          continue;
        }
        if (result === "clear") result = "active";
      }
    } finally {
      directory.closeSync();
    }
    const rootAfterInventory = fs.lstatSync(root, { bigint: true });
    const descriptorAfterInventory = fs.fstatSync(rootDescriptor, { bigint: true });
    if (!sameIdentity(rootIdentity, rootAfterInventory)
        || !sameIdentity(rootIdentity, descriptorAfterInventory)) {
      throw new Error("staging app root changed during cutover journal inventory");
    }
  } finally {
    fs.closeSync(rootDescriptor);
  }
  process.stdout.write(`${result}\n`);
' "$app_dir")"; then
  :
else
  cutover_temporary_scan_status=$?
fi
if [ "$cutover_temporary_scan_status" -ne 0 ]; then
  echo 'Staging helper installation could not safely inventory cutover journal temporaries' >&2
  exit 69
fi
case "$cutover_temporary_scan" in
  active)
    echo 'Staging helper installation blocked by an active cutover journal temporary' >&2
    exit 75
    ;;
  unsafe)
    echo 'Staging helper installation blocked by an unsafe cutover journal temporary namespace' >&2
    exit 75
    ;;
  clear) ;;
  *) echo 'Staging helper cutover journal temporary inventory is invalid' >&2; exit 69 ;;
esac

cutover_journal="$app_dir/.staging-recovery-required"
if [ -e "$cutover_journal" ] || [ -L "$cutover_journal" ]; then
  echo 'Staging helper installation blocked by an active cutover journal' >&2
  exit 75
fi

# The cutover lease is published through a small, fixed sibling namespace.
# Scan its parent through a bound descriptor so installation cannot mistake a
# crash intermediate for an idle host. Its exact `.released.tombstone` is
# deliberately outside this active namespace; the app journal check above
# distinguishes a completed cutover from one that still needs recovery.
cutover_lock_namespace_scan=''
cutover_lock_namespace_scan_status=0
if cutover_lock_namespace_scan="$(node --input-type=module -e '
  import fs from "node:fs";
  import path from "node:path";
  const lockPath = path.resolve(process.argv[1]);
  const parent = path.dirname(lockPath);
  const base = path.basename(lockPath);
  const maximumEntries = 4096;
  const maximumNameBytes = 255;
  const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;
  let parentIdentity;
  try {
    parentIdentity = fs.lstatSync(parent, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      process.stdout.write("clear\n");
      process.exit(0);
    }
    throw error;
  }
  if (parentIdentity.isSymbolicLink() || !parentIdentity.isDirectory()) {
    throw new Error("staging host-operation parent is not a real directory");
  }
  const descriptor = fs.openSync(parent,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let result = "clear";
  let entries = 0;
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const afterOpen = fs.lstatSync(parent, { bigint: true });
    if (!opened.isDirectory() || !sameIdentity(parentIdentity, opened)
        || !sameIdentity(opened, afterOpen)) {
      throw new Error("staging host-operation parent changed while opening");
    }
    const directory = fs.opendirSync(`/proc/self/fd/${descriptor}`);
    try {
      for (;;) {
        const entry = directory.readSync();
        if (entry === null) break;
        entries += 1;
        if (entries > maximumEntries) {
          throw new Error("staging host-operation parent inventory exceeds its safety bound");
        }
        const nameBytes = Buffer.byteLength(entry.name, "utf8");
        if (nameBytes < 1 || nameBytes > maximumNameBytes) {
          throw new Error("staging host-operation parent name exceeds its safety bound");
        }
        const fixed = new Set([base, `${base}.preparing`]);
        if (fixed.has(entry.name)) {
          if (result === "clear") result = "active";
          continue;
        }
        const claimPrefix = `${base}.claim-`;
        if (!entry.name.startsWith(claimPrefix)) continue;
        const claimSuffix = ".preparing";
        const digest = entry.name.endsWith(claimSuffix)
          ? entry.name.slice(claimPrefix.length, -claimSuffix.length) : "";
        if (/^[a-f0-9]{64}$/u.test(digest)) {
          if (result === "clear") result = "active";
        } else {
          result = "unsafe";
        }
      }
    } finally {
      directory.closeSync();
    }
    const afterInventory = fs.lstatSync(parent, { bigint: true });
    const descriptorAfterInventory = fs.fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(parentIdentity, afterInventory)
        || !sameIdentity(parentIdentity, descriptorAfterInventory)) {
      throw new Error("staging host-operation parent changed during inventory");
    }
  } finally {
    fs.closeSync(descriptor);
  }
  process.stdout.write(`${result}\n`);
' "$host_operation_lock_directory")"; then
  :
else
  cutover_lock_namespace_scan_status=$?
fi
if [ "$cutover_lock_namespace_scan_status" -ne 0 ]; then
  echo 'Staging helper installation could not safely inventory the release host-operation namespace' >&2
  exit 69
fi
case "$cutover_lock_namespace_scan" in
  active)
    echo 'Staging helper installation blocked by an active host-operation lock' >&2
    exit 75
    ;;
  unsafe)
    echo 'Staging helper installation blocked by an unsafe host-operation lock namespace' >&2
    exit 75
    ;;
  clear) ;;
  *) echo 'Staging helper host-operation namespace inventory is invalid' >&2; exit 69 ;;
esac

node "$source_dir/staging-helper-bundle.js" install "$source_dir" "$install_root" "$link_root"
