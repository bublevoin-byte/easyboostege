# Read-only staging baseline

Captured over pinned-host SSH before any cutover mutation on 2026-09-04.

- Node.js: `v22.23.2`
- zlib: `1.3.1-e00f703`
- App container ID:
  `c5667cddf8f05808b2394a0085590390aab983147913710b00c98640bb850784`
- App image ID:
  `sha256:0ea11a509d5b5642b5c88485cf5f92413cc3c4fcd63c1327af9ac2e064190db4`
- PostgreSQL container ID:
  `21189a29fd1e4318455686a6b90e6f9c2fa26b1c3b12e2a92e002bbdd7cd858c`
- PostgreSQL image ID:
  `sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193`
- PostgreSQL state: `running`, health: `healthy`
- PostgreSQL volume: `easyboost-staging_postgres-data`, driver/scope `local/local`
- PostgreSQL mount:
  `/var/lib/docker/volumes/easyboost-staging_postgres-data/_data` →
  `/var/lib/postgresql/data` (`RW=true`)
- Live legacy Compose SHA-256:
  `91d2484b9cb03c6d7b5c2b26b36bc7f2b8abd3794285abf952927ffa7039d7d7`
- Live legacy marker value:
  `9e70f9f501cfa6e65f509c114a08a3e0dbb86c56f55ff2911ae7aa6c5522dfda`
- Marker-file byte SHA-256:
  `5170360fd6f26d240b36b973c4c662fa20e597e156f552bc4d3a9891146b720c`
- Exact legacy mode tuple captured read-only on 2026-09-04 before cutover:
  app root `root:root 0700`, marker `root:root 0644`, Compose `root:root 0664`.
- Backup and rollback roots: `root:root 0700`; `rollbacks/releases/` remains absent.
- The legacy Compose group-write bit is accepted only as this hash- and tuple-bound migration input
  under the enclosing root-owned `0700` app directory; it is not an allowed v4 runtime mode.
- Local readiness: `{"status":"ready","storage":"postgres"}`

After cutover and after the first real deploy, the PostgreSQL container ID, image ID, volume name,
mount source/destination and readiness storage must remain identical. The app container may change only
during the real UI deploy, not during metadata-only cutover.

## Recheck during CI repair — 2026-09-04 23:31–23:32 UTC

Read-only SSH with the existing key and strict known-host checking; no remote files, processes,
containers or database data were changed.

- Local and public readiness both returned `{"status":"ready","storage":"postgres"}`.
- App/PostgreSQL container IDs, PostgreSQL image/volume/mount, legacy marker and Compose SHA/modes
  are identical to the baseline above. Both containers reported healthy and up for four weeks.
- Installed helper remains `e08586835306c143a44c7be5a2dd8394798977d8a8846aa87a7e473e30827f4f`.
- Release store is still absent; app recovery journal is absent. The old exact deadline namespace,
  reserved retirement slot and POSIX session/baton plus four retained POSIX tombstones still exist.
  No cleanup or retry was attempted by this check.
- `df -Pm`: root filesystem available 4490 MiB; `/tmp` is a 982 MiB tmpfs with 778 MiB available.
  This is only observed headroom, not proof of admission for a new build/deploy.
- Local raw metadata log: `.scratch/staging-v4-cutover/artifacts/server-readonly-20260905.log`
  (ignored; contains selected metadata only, no environment values or student records).
- Additional anonymous-memory `memfd` probe acquired a flock in a child, waited for that child to
  exit, and read the inherited descriptor's fdinfo: the staging host reported a positive recorder
  PID, unlike the Docker Desktop PID-0 observation. The probe created no filesystem entry and
  acquired no application/maintenance lock. No production parser change is warranted by the
  local Docker Desktop limitation.

## Deployment capacity warning — not a new UI change

Do not infer deploy admission from the green readiness checks. The existing helper hard-codes its
large private work directory under `/tmp`. With the already-known `b407...` candidate metrics
(235145032 expanded / 213393995 compressed), the verified legacy bridge predecessor
(61029623 / 55088746), a 256 MiB bounded DB backup and 64 MiB headroom, `admit_release_space`
requires **900201716 bytes** available on that temporary device after candidate/predecessor archive
copies have already been frozen. The observed tmpfs has only 778 MiB free before those copies.
Even moving the upload elsewhere does not prove admission against the 982 MiB tmpfs capacity.

This is a separate host-storage prerequisite for the real UI deploy, not a reason to weaken the
capacity check or delete arbitrary files. Recompute for the exact new release. A disk-backed private
workspace (or an explicitly approved host-storage configuration change) must be addressed before
attempting deployment. No script, mount, `/tmp` configuration or live file was changed for this finding.
