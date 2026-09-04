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
