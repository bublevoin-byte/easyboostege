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
