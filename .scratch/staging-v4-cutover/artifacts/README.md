# Verified staging bridge artifact

The local binary `easyboost-staging-bridge-8e8d4aa-v4.tar.gz` is intentionally ignored by Git.
It is the one-time bridge from the live legacy staging tree to the immutable-archive-v4 Compose
contract.

- Legacy Git commit: `8e8d4aa3d22362903fbbc7f97e8aae835b26627d`
- Observed live legacy marker: `9e70f9f501cfa6e65f509c114a08a3e0dbb86c56f55ff2911ae7aa6c5522dfda`
- Observed and reconstructed legacy Compose SHA-256:
  `91d2484b9cb03c6d7b5c2b26b36bc7f2b8abd3794285abf952927ffa7039d7d7`
- Bridge archive SHA-256:
  `57d434af692ce26aae0daf93df55e6a2903dd8a6871ba27d30f4b5b85ea97d8c`
- Bridge archive bytes: `55088746`
- Expanded bytes: `61029623`
- Members: `882`
- Bridge Compose SHA-256:
  `af431736fd9a293a517fc4024785d6da024cc7dffb6428e1649babf1ce7c7fdc`
- Bridge Compose Git blob: `79eaa51dbaa6cfdfac9f457e7932bbb329a8f449`
- Producer: Node.js `v22.23.2`, zlib `1.3.1-e00f703`

The archive was built from a detached LF-only checkout. Before creation, `git diff-files` proved
that only `compose.staging.yml` differed from the legacy commit, and its raw blob matched the current
v4 Compose blob. After creation, `verify-tree-transition` proved exact inventory and bytes with only
`compose.staging.yml` allowed to differ; the reconstructed legacy Compose hash matched the live server
hash above.

## CI repair helper candidate — not yet cleared for installation

`easyboost-staging-helper-bootstrap-aa670f75.tar.gz` contains the frozen CI-repair helper sources,
not the application release. Do not install until the repair commits and Linux CI are verified.

- Helper bundle SHA-256: `aa670f75c0b433c6028cc2d5d39144ab3bc3d236539586ea6926247856a3fb61`
- Archive SHA-256: `4a83eb274a143263f0ba3c3d09118da76746144f4b21ba460ecd71e659bd94b6`
- Archive/expanded bytes: `172395` / `902650`; files: `18`.
- Producer: Node `22.23.2`, zlib `1.3.1-e00f703`.
- Canonical archive inspection and exact source-tree verification passed locally. All 18 files
  match exact Git blobs at helper-source commit `d173c645a1dec4c8e83316350927ec700b218410`.
  All helper
  sources are LF; `package.json` was exported from its unchanged Git blob so Windows working-copy
  line endings do not alter the candidate. The following fixture-only repair does not change these files.
- The previous `944b9b8-323d5cb` helper bootstrap is historical and does not contain this repair.
  The legacy bridge archive documented above is unchanged.

## Disk-workspace helper candidate — provisional, do not install

`easyboost-staging-helper-bootstrap-89b506d5.tar.gz` includes the frozen issue09 workspace change.
It supersedes the aa670f75 candidate for future installation, but it is not yet cleared: the new
common gate, commit/source-blob comparison and actual Linux CI remain outstanding.

- Helper bundle SHA-256: `89b506d5b5e74ecce8ce65d29a7e0fe9c2a9b6c4380de9dc515d4c469d465e4e`.
- Archive SHA-256: `9d6fc415dacf7b3887e8818e11ede65b29ea26cf4b34f04edcd187396d9ea24e`.
- Archive/expanded bytes: `172803` / `904783`; files: `18`.
- Producer: Node22.23.2, zlib1.3.1-e00f703. Canonical inspection and exact source-tree verification passed.
- Inputs are 15 exact LF Git blobs from b2b0b0f and the three exact frozen issue09 helper files.
  No package, installer, UI, credential or deployment-state content was inferred or copied from VPS.
  After the implementation commit, compare all 18 packaged files to its Git blobs before use.
- Issue10 changes only the test fixture and does not change this helper digest.

This89b506d5 package is now superseded: the reviewed issue09 operation-allowlist follow-up changes
the common helper's bytes. Retain it as historical evidence, never install it as the final candidate.

## Integrated workspace helper candidate — provisional, do not install

`easyboost-staging-helper-bootstrap-7ab70170.tar.gz` contains the exact integrated issue09 helpers.
Final common gates and exact commit/source-blob comparison passed. Actual Linux CI is still required
before owner installation; this is not a deployment or live recovery result.

- Helper bundle SHA256: `7ab70170bd696eed3be82a067e04faa379ff7d2c2398f7262a9cb10d86732701`.
- Archive SHA256: `b7194b5492277c42e4ee8b79c28121a26d06f44166c9368c1c087691deb16f68`.
- Archive/expanded bytes: `172800` / `904791`; files: `18`.
- Producer: Node22.23.2, zlib1.3.1-e00f703. Canonical inspection and exact tree verification passed.
- Initial inputs:15 exact b2b0b0f Git blobs plus3 exact integrated working helpers. After commit,
  all18 packaged files were byte-compared with raw Git blobs at
  `567bfaf28db8853c0385de67081bc0686beddb9b`; canonical archive and tree verification passed again.
  The two task-owned temporary packaging roots89b506d5/7ab70170 were removed only after exact
  path/inventory/no-reparse validation. All repository archives and logs are preserved; their bytes
  remain recoverable from the verified archives and Git. No upload/install/live action was performed.
- Issue10 and11 are test-only and do not alter this helper digest.
