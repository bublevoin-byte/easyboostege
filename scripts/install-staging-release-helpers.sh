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
case "$install_root:$link_root" in /*:/*) ;; *) echo 'Helper installation roots must be absolute' >&2; exit 64 ;; esac
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
node "$source_dir/staging-helper-bundle.js" install "$source_dir" "$install_root" "$link_root"
