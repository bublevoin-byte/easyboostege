# 02 — Authority попытки, таймеры и хранение

Status: done
Blocked by: 01
Spec: .scratch/ege-full-mock-2026/spec.md#модель-попытки-и-authority

## Что сделать

Добавить owner-bound lifecycle полного пробника в file/PostgreSQL, миграцию и `/api/v1/ege-mocks`: start/current/restore, CAS draft, written submit, oral start/submit, result и bounded assessment retry. Сервер владеет form identity, diagnostic/training mode, deadlines, state/revision, idempotent receipts и score authority.

## Границы

- Входит shared repository contract, migration, API, validation, executable OpenAPI, export/delete/retention и concurrency.
- Start возможен только online и при активной подписке.
- Не входит browser runner, фактический provider-вызов или result UI.

## Файлы

- `migrations/`, `db/`, `services/`, `routes/`, `validation/` — storage/API authority.
- `docs/openapi.yaml`, generator/evaluator — executable schema.
- `test/` — file/PostgreSQL shared contract и HTTP integration.

## Definition of Done

- [x] TDD RED покрывает owner isolation, deadline, CAS, replay/conflict и mode split.
- [x] File и PostgreSQL одинаково проходят lifecycle/export/delete/retention.
- [x] Старый receipt нельзя применить к новой revision/UUID/payload.
- [x] Result не раскрывает keys до завершения обеих частей.
- [x] OpenAPI runtime-parity исполняема.
- [x] Full gates и mandatory live PostgreSQL зелёные с cleanup.
- [x] Fresh Standards + Spec review даёт literal `ZERO_FINDINGS` ×2.
- [x] Один локальный commit; push/deploy отсутствуют.

## Pre-review verification evidence

- Initial focused file/HTTP/executable-OpenAPI lifecycle passed `14/14`. The first fresh-review remediation recorded exact RED `15 total / 8 pass / 7 intended fail` → GREEN `15/15`: the answer-free form publishes versioned policy `ege-mock-attempt-policy-v1` (`190m / 30d / 17m`), every attempt pins its policy ID, manual and automatic receipts digest the complete ordered authoritative payload including blank positions, file mutations share one owner/subscription/idempotency helper, and file/PostgreSQL export reconcile timers transactionally before projection. A later fresh Spec review found one queued stale-clock seam; an exact public HTTP RED `0/1` returned `200` after crossing the written deadline in the occupied file queue, then GREEN expanded the focused contour to `16/16` by passing a clock thunk and evaluating it only inside the file owner queue. Final Standards/Spec review then required a deeper domain seam and explicit concurrent-submit proof: focused RED `2 total / 1 pass / 1 fail` (missing pure domain operations; file shared race already green) → GREEN `17/17`; `attempt.js` owns mutation guards/transitions/results, while the shared file/PostgreSQL contract races both written and oral submit, accepts exactly one winner, bounds the loser and verifies the persisted/exported winner receipt. The last Standards review found residual start/current policy duplication; a direct domain RED `0/1` → GREEN expanded focused coverage to `18/18`, with active-state selection, diagnostic-to-training mode and monotonic attempt numbering now owned only by `egeMockStartDecision`. A final export-surface RED `0/1` proved raw transitions, payload digests, normalizers and duration constants were importable; GREEN retained `18/18` while making those implementation details private and leaving only guarded lifecycle/apply/reconcile/start-decision/projection seams public. The next Standards review found that the executable nullable-attempt schema rejected the route's valid empty-current projection: exact OpenAPI RED `0/1` reported `# must have type object`; a null-only/reference `oneOf` plus runtime-parity assertions for `null`, a populated attempt and an invalid empty object produced HTTP/OpenAPI GREEN `3/3` and retained the full focused GREEN `18/18`. A final full Standards pass then caught invalid OpenAPI 3.0 `type: null` in the blank-draft branch: exact RED `0/1` prohibited that keyword; the valid nullable null-only branch returned GREEN `1/1`, with executable coverage accepting string/array/null answers and rejecting boolean/object/forbidden-position shapes while focused coverage remained `18/18`.
- Final full unit suite: `1596 total / 1552 pass / 44` expected no-DB skips / `0 fail`.
- Final disposable live PostgreSQL project `easyboost-postgres-integration-36860` applied migrations `001–053` and passed `44/44`, including domain-owned start/current mode decisions, both concurrent submit races, the shared lifecycle/export/delete contract, authoritative manual/automatic payload digests, persisted exact-deadline reconciliation after a rejected late draft, transactional export reconciliation and PostgreSQL's after-owner-lock clock authority. That evidence remains applicable after the nullable OpenAPI remediation because only documentation, the executable schema and its parity test changed; server routes, runtime validation, domain, repositories, migration and persistence were untouched.
- Compose removed the final disposable container, network and volume; independent exact-label container, network and volume filters were all empty. Docker Desktop was then stopped by the parent task and the daemon pipe was absent.
- Lint, syntax/inline check (`391` JavaScript files; `211` handlers / `126` names), generated OpenAPI check, frontend build (`484` assets / `11` lazy chunks), tracked secret scan (`1156` files), history scan (`309` commits) and diff-check are green. Package manifests did not change, so no new dependency audit was required. Browser/provider calls, install, push and deploy were not performed.
- Fresh full Standards and Spec reviews both returned literal `ZERO_FINDINGS` on the same deterministic bytewise 19-path identity `9dde7fdaedf2930a9ff5f162af8d1ae478eaf844fae096051c96c431168f6344` at base/HEAD `9f397671a3bc9d919662f355a2b990c182fce8bd`; this final status/DoD update is metadata-only before the sole local commit.
