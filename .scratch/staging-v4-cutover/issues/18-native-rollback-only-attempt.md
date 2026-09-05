# 18 — Attempt the reviewed reduced rollback on native Linux

Status: in-progress
Blocked by: 17 — reviewed local rollback-only command committed as5c59947
Spec: .scratch/staging-v4-cutover/spec.md#native-rollback-only-diagnostic-execution

## Deliverable

Wire the existing fixed reduced rollback into its own disposable native GitHub-hosted job so root
can collect one exact result without the successful-deploy prefix. This is diagnosis, not a repair.

## Scope and files

- `.github/workflows/staging-lock-diagnostic.yml`: add a separate6minute Ubuntu job, checkout with
  persist-credentials:false, setup-node22.23.2, existing reduced contracts, then fixed rollback
  command as its last user-defined step. Add only exact reduced-script trigger paths. Existing
  native-lock-diagnostic job stays unchanged; canonical ci.yml is entirely out of scope.
- `.scratch/staging-v4-cutover/debug/ci126-rollback-only.mjs`: only clarify lifecycle comments and
  fixed cleanup label to cover either disposable container or dedicated hosted VM. No behavioral
  changes to exit tracking,120s assertion,210s lifetime,30s settlement or actual helper invocation.
- `.scratch/staging-v4-cutover/diagnostics/README.md`: document fixed invocation, dedicated-runner
  lifetime, no native result yet, no cleanup/production-readiness inference.
- This ticket: implementation and focused validation. Root owns spec/PROGRESS/checkpoint/results.
- No new framework, test seam, command wrapper, production edits, existing test edits, npm install,
  VPS/network/deployment/commit/push by worker. The existing6contract tests are sufficient here;
  actual GitHub execution is the workflow verification and remains with root.

## Definition of Done

- [x] Dedicated native job has exact scope/runtime/resource/permission limits.
- [x] Existing full diagnostic job and canonical CI remain unchanged.
- [x] Existing reduced test contracts, syntax and explicit lint pass; changes reviewed independently.
- [ ] Root commit/publication and native result recorded; until then leave in-progress, not done.

The known local actual rollback refused at841ms with child125; no local full rollback rerun.
Use cached Linux only for focused contracts if needed. The only externally authorized publication
branch is prototype/aisy-today-visual-v1; root performs that publication after review.

## Local implementation — 2026-09-05

Added one independent `native-rollback-only-diagnostic` job on `ubuntu-latest`, with a6-minute
total bound, checkout `persist-credentials: false`, and Node22.23.2. The existing six contracts
run before the fixed real rollback command, which is the last user-defined step. The workflow
retains `contents: read` only; no container, services, secrets, installation or upload is added.
Only the two exact reduced `.mjs` paths were added to push triggers.

The diagnostic retains all operation/result handling and its120000/210000/30000ms bounds.
Lifecycle comments and `cleanup: disposable-environment-lifecycle` describe disposal by the
outer container or dedicated hosted VM. At root's review request, the misleading JSON field
`descendantsProven` is renamed `helperCompletedCleanly` with its expression unchanged. A clean
helper completion is not an independent descendant census. Fixture state and uncertain
descendants remain retained for outer disposal; no helper cleanup success is inferred.

Focused validation uses the unchanged existing contracts; no tests or test seams were added.
Pinned Windows Node22.23.2:6tests/4pass/2Linuxskip/0fail,268.2481ms. Both `.mjs` syntax checks
and explicit repository-rule ESLint pass,2files/0errors/0warnings; repository ESLint configuration
is unchanged. Whitespace checks pass. Read-only comparison against5c59947 confirms the existing
`native-lock-diagnostic` job body, canonical CI and reduced test file are unchanged. The prior
reviewed Linux6/6 evidence remains in ticket17; no Linux rollback or full-suite rerun was made.

The worker changed only the four ticket-owned paths. No native rollback-only result exists yet;
root owns independent reviews, shared records, common input-equality checks, scoped commit,
authorized publication and actual native execution. This ticket remains in-progress until those
obligations and the native outcome are recorded. No production repair or readiness is claimed.

## Root pre-publication checks

Independent Standards0/Spec0 on the frozen change. Fresh root43focused contracts/consumers EXIT0,
full lintEXIT0 and checkEXIT0(571JS,165handlers/106names); explicit diagnostic lint/syntax passed.
Scoped secret scan1570tracked+5explicit candidates/1572unique filesPASS; whitespacePASS. Product,
scripts, existing tests, package inputs and canonical CI are unchanged from5c59947; the previously
completed full Windows3241-test gate is reused only for those identical inputs. The old native
full-scenario job is unchanged. Root approved a scoped commit and publication to the authorized
prototype branch; actual native outcome is still pending, so the ticket remains in-progress.
