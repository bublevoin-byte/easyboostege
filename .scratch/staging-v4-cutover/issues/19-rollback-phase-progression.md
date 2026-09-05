# 19 — Preserve the original timeout while observing late rollback progress

Status: in-progress
Blocked by: 18 — native reduced result captured, not original exact signature
Spec: .scratch/staging-v4-cutover/spec.md#reduced-rollback-phase-progression-after-the-unchanged-assertion

## Deliverable

Add bounded phase/late-barrier evidence to the existing reduced diagnostic. Preserve the original
120second failure exactly; observe whether the real operation later advances or settles. This
does not choose or implement a production fix.

## Files and boundaries

- Existing `.scratch/staging-v4-cutover/debug/ci126-rollback-only.mjs` and `.test.mjs`: extend the
  same real-child observer seam with bounded phase sampling and a distinct settlement observation.
- `.scratch/staging-v4-cutover/diagnostics/README.md` and this ticket: fixed command, budgets,
  limits, measured focused validation. Root owns spec/PROGRESS/checkpoint/native results.
- Freeze initial120000ms verdict; late successful completion must remain nonzero if it timed out.
- At most16allowlisted phase rows,500ms-or-slower sampling, omitted count,2048byte line cap;
  report late tree and final phase separately. No raw child streams/authority/command arguments.
- Diagnostic-only later observation180000ms, outer watchdog330000ms within unchanged6minjob.
  Production timeouts and the original full test are untouched; outer disposal stays explicit.
- Test-first at the actual orchestration seam with a finite real phase-writing child and short
  injected module-test budgets; CLI still accepts no arguments/env overrides. No generic framework.
- No production/script/test/workflow changes, new dependencies, network/VPS/commit/push by worker.
  No actual Docker Desktop rollback retry; its known125refusal is irrelevant to this new question.

## Definition of Done

- [x] Initial failed verdict stays frozen across late tree/success; exact child failure preserved.
- [x] Bounded real-child phase timeline and output/settlement evidence tested at actual caller seam.
- [x] Syntax/lint/focused tests and independent review completed; old production/test inputs intact.
- [ ] Root records scoped publication and one native result before marking done.

Native baseline: run33956320307/job101280204635, commitbc6313c. Contracts6/6; installer567ms,
equivalence2488ms;120018ms lastPhase build-complete/upCount missing/tree absent/empty streams,
launcher not exited. Separate30s settlement unclosed at150049ms; diagnostic124. These facts
do not prove deadlock, cause or exact equivalence to the original config-json-complete timeout.

## Worker implementation and focused validation — 2026-09-05

The fixed CLI now calls `observeRollback`, which freezes the original barrier snapshot/verdict,
releases the same fixture marker, samples existing phase/tree evidence and observes later pipe
settlement. CLI defaults remain120000ms for the initial tree assertion; only later observation
and the outer disposable-process watchdog change to180000/330000ms. Short module-test budgets
and a captured reporting sink are unavailable through CLI arguments or environment variables.

The phase sampler waits at least500ms between completed reads. It accepts only existing fixture
phase names, keeps at most16 `{elapsedMs, phase}` entries and counts subsequent omitted updates.
The existing phase file's sampled modification time distinguishes repeated writes of the same
phase; modification times are not output. Repeated config phases can occur at different places
in a rollback, and quick writes can be missed; these observations are not exact invocation counts
or proof of how far one run progressed compared with another. Final phase, late tree/first-seen
time, final stream byte counts, launcher `exited` and pipe `closed` are reported separately from
the immutable initial snapshot. The existing2048byte report cap and private stream caps remain.

TDD at the actual command's orchestration seam used real finite phase-writing Node children:

- Late-tree/clean-exit RED: missing `observeRollback`,1fail/3801.7212ms. Initial GREEN:1pass/1102.8337ms.
  Final contracts also prove exact late child23 survives and private stderr is represented only
  as15bytes, never its content. Earlier failed assertion remains nonzero after late child0.
- Timeline-cap RED: no phase-timeline report,1fail/15588.5403ms. GREEN: sampled real24-update
  child reaches16entries plus omittedCount; invalid phase stays private; final phase remains
  available after the cap. Two-contract GREEN16596.0548ms.
- Repeated-value RED:2observations instead of3/2858.7608ms. GREEN with same-file modification
  evidence:3focused contracts/4858.2351ms. Same-value rewrites remain distinguishable when sampled.
- Explicit final exit-state RED: absent `exited` instead of false/1635.3412ms; final suite GREEN.
  A finite unsettled child with100ms later observation retains fixture evidence and returns124;
  test cleanup waits for its natural closure. No observer signals or active-fixture removal.

Final fixed contract command:

```sh
node --test .scratch/staging-v4-cutover/debug/ci126-rollback-only.test.mjs
```

Windows pinned Node22.23.2:11tests/9pass/2Linuxskip/0fail,22129.3172ms. Cached Linux Node22.23.1:
11tests/11pass/0skip/0fail,23662.913213ms. Linux used existing image44f22c911346, no pull/network,
read-only repository/runtime/image, user1000:1000 and512MiB disposable executable `/tmp` tmpfs.
The first cache launch failed before Node because tmpfs was noexec; it ran no contract/rollback.
Adding exec to that temporary mount allowed the finite contracts. No actual rollback was rerun.

Both diagnostic syntax checks and explicit repository-rule ESLint pass:2files/0errors/0warnings.
Whitespace checks pass. Read-only comparison against HEAD confirms production scripts, existing
tests and workflows unchanged; root additionally verified equality for the previously completed
full Windows gate. No full-suite repetition, dependency install, VPS/network action, workflow
change, commit or push by this worker. Only the four ticket-owned files were changed.

Implementation is frozen for independent root reviews. Root owns shared records, scoped
publication and the next native result; this ticket remains in-progress until those are recorded.
No production repair, cause, exact native reproduction equivalence or release readiness is claimed.

## Root review and publication gate

Independent Standards0findings and Spec0findings on the frozen code/test hashes above. Fresh
root Node22.23.2 diagnostics and release/PROGRESS consumers:48tests/42pass/6Linuxskip/0fail/
0cancel22341.8006ms. Common lint and check pass (571JS,165handlers/106names); explicit diagnostic
ESLint2files passes. Scoped secret scan1571tracked+6explicit/1573unique files and whitespace pass.
Original product/scripts/tests/packages/canonicalCI are byte-identical to the completed full
Windows baseline; no unchanged full-suite rerun. Diagnostic workflow remains byte-identical.
Root publication and one native result are still pending; the ticket is not marked done yet.
