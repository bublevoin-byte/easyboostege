# Известные ограничения

## Azure pronunciation assessment

The production adapter is deliberately optional and remains unavailable until the official SDK, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, and the explicit enable switch are present. No fallback invents acoustic scores. Only `en-GB` and `en-US` are accepted. Azure exposes prosody, IPA phoneme names, syllables, and spoken-phoneme candidates only for `en-US`; `en-GB` still retains available acoustic scores but reports those fields as unavailable/absent. Provider acoustic scores are training signals, not validated FIPI/EGE points.

The verified Node SDK input accepts strict PCM16 mono 16 kHz WAV only. The official Speaking 1–4 browser flow now decodes `MediaRecorder` output locally and converts it to PCM16 mono 16 kHz WAV only after explicit learner action; the server still rejects WebM/MP4 and every other encoded container and has no transcoder.

- Полностью валидированный отдельный endpoint пока существует только для письменных заданий 37/38; генерация других модулей использует bounded legacy AI route.
- Оценка произношения по STT не заменяет фонетический анализ и не должна интерпретироваться как точная экспертная оценка.
- Offline mode сохраняет и синхронизирует прогресс по верхнеуровневым модулям; ИИ, Telegram, TTS/STT и подписка требуют сети.
- Browser matrix и полноценные E2E на реальных iPhone Safari/Android Chrome ещё не завершены.
- Ролевая модель преподавателя ещё не реализована; self-service экспорт и подтверждённое удаление данных доступны пользователю.
- До ротации production AI-ключей релиз считается ограниченным pre-release.
- Reading 2.0 закрывает отдельные тренировки и полный раздел чтения 10–18, но не является цельным пробником всей письменной и устной частей ЕГЭ; такой пробник остаётся следующим этапом.
- Расширенный Reading-отчёт показывает наблюдаемые связи только по завершённым каноническим попыткам (не более 120 последних строк). Малые выборки явно помечаются; темы, CEFR-метки и рекомендации не доказывают освоение или причинную связь.

## Controlled PWA rollout boundary

Ticket 07 intentionally fails closed with `CLIENT_UPDATE_REQUIRED` when an ordinary Writing task request lacks the
new expected-owner/idempotency headers. The server performs no provider, quota, delivery or attempt mutation in
that case. A pre-Ticket07 page already running from an old service-worker cache can still catch HTTP 428 in its old
JavaScript and display the former fabricated local review; this server cannot repair text already embedded in that
legacy client without weakening owner intent or exactly-once safety.

Ticket 11 provides a content-addressed worker, real waiting state and exact d367 predecessor executable artifact.
Because one scope cannot have a different active worker per tab, `skipWaiting` is gated by explicit consent from
every live participating same-origin WindowClient (a closed tab leaves the quorum). Static `/privacy.html` and
`/offline.html` pages do not execute a learning task and are deliberately excluded from consent/readiness quorum.
Participation is positive, not a same-origin wildcard: legacy `/`/`/index.html` documents qualify, and a real
learner-shell deep link qualifies only after its exact WindowClient performs the learner-shell handshake. Health,
API, internal, static and other passive same-origin windows do not enter either quorum merely by being controlled.
While another participating tab remains nonconsenting and quorum is incomplete, Apply does not activate the worker
or reload the current task: a nonconsenting d367 document can finish its task and fetch a genuinely unvisited old
hashed lazy chunk. After Apply, the misleading Later action is removed and keyboard focus
returns to the prior valid task control while the status says that other tabs are still being awaited. After quorum,
each consenting page follows `statechange` on its exact consented waiting worker, waits until that worker is
`activated`, and only then reloads. Update activation deliberately does not call `clients.claim()`, so passive and nonconsenting tabs are
neither claimed nor reloaded. `controllerchange` is only an idempotent fallback for that same consented worker in
that same page; the shared guard permits at most one reload. Offline navigation during that handoff reads the root
and lazy assets from the exact current cache, never a retained predecessor or foreign namespace. The
old Aisy release cache is retained until every resulting candidate document reports `CURRENT_CLIENT_READY`. During
activation the worker persists only the strict immutable predecessor authority from the verified compatibility record:
schema, full base commit, content SHA-256 and exact cache name. The record is bounded by schema/count/name and 1024
bytes; missing, oversized or tampered authority means no prune. Delayed pruning deletes only that exact predecessor
cache and never calls `caches.keys()`, so an already-present future C, colliding prefix, foreign or unknown cache cannot
be captured or deleted. Static, release-qualified EGE executable/install and client-state caches remain disjoint.

The exact d367 document predates the Ticket 11 update card and heartbeat. It only shows its existing refresh notice;
it cannot offer current per-tab consent. The verified route therefore requires an ordinary **online reload**. Its old
network-first controller serves the candidate document while remaining the active controller and leaving the candidate
worker waiting; only then does the visible current Apply control record consent. A d367 tab that is neither reloaded
nor closed remains a truthful nonconsenting quorum member, so activation cannot be silent.

After a reloaded Ticket 11 document consents, the waiting worker polls quorum every 250 ms for at most 240 attempts
(60 seconds) per message. The page sends a heartbeat every 55 seconds; a heartbeat received during an active loop
queues exactly one following bounded loop, rather than overlapping it or extending one `event.waitUntil` forever.
Consequently a still-old peer can finish its task, load its packaged old lazy bytes and close later; the current
consenting page keeps liveness coverage beyond the original minute. If every open tab remains an untouched d367
document, none has consented or runs the current heartbeat, and the update safely remains waiting until a tab reloads
online or closes. This platform boundary is intentional and must be explained during a phased rollout.

The packaged compatibility graph covers exactly `d36724181ee04230c1a9709a9213bcd269092282`; a service worker still
cannot rewrite JavaScript from arbitrary older releases that was already executing. Any rollout with pre-d367
documents therefore needs a phased compatibility window: publish the Ticket 11 static/SW candidate while the old
backend remains available, allow unsupported documents to close/update, and only then cut over strict backend
contracts. A combined unobserved cutover is not supported. No rollout or deployment was performed as part of Ticket 11.

## Staging immutable-archive cutover

Ticket 11 follows the explicit release-safety scope amendment dated 2026-08-29. The audit made the
image-build/recovery boundary necessary to prevent live backups, rollback archives, secrets and untracked
debris from becoming Docker context. The existing `/autopilot` request and repeated `продолжай` commands
authorize continuation of that bounded implementation; they are not a separately spoken visual/product
decision, staging redesign approval or deployment approval. The amendment excludes deploy, live provider/
registry/network calls, secrets transfer and broader operator redesign. The helper still does not deploy
anything automatically.

The first cutover is intentionally fail-closed. Before the new workflow runs, an operator must install
the atomic digest-verified root-owned `immutable-archive-v4` helper bundle, then seed the active
full `.release-sha256` plus its exact retained CI archive/checksum sidecar. The live tree and stable image
must also match that retained predecessor. A legacy mutable `code-before-*.tar.gz`, missing pair or
abbreviated/default rollback target is not migrated or guessed. Deploy/rollback require Linux, Node.js,
`/usr/bin/python3`, libc/kernel/filesystem support for `renameat2(RENAME_NOREPLACE)`, GNU coreutils and
`flock`; the installer probes that syscall on `/tmp` and fails closed before changing a generation.
`postgres:17-alpine` must already exist locally as a seed because activation uses
`--pull never`. The helper captures its canonical SHA256 ID and exports the immutable Compose authority before
configuration or activation; a later retag fails closed and cannot change the selected image. The shared lock
prevents concurrent build/tree/recovery changes. The mutable
archive-checksum-named tag identifies the selected verified archive inside that transaction; it is not
an immutable provenance attestation or a byte-reproducible image because upstream base-image tags and
registry state remain mutable.

Rollback is code/image/tree-only: PostgreSQL schema and data are never automatically rolled back or
down-migrated. Releases therefore need backward-compatible migrations, or a separate verified DB restore
procedure with explicit owner approval. Recovery is successful only after the prior tag, exact tree,
marker, running image identity and readiness all verify. A failed recovery leaves a fail-closed marker.
Identity-bound transaction-owned temporary/final publication cleanup requires exact release-store
revalidation. Success is emitted only after the reservation is removed and the whole release store is
revalidated. Verified prior state restored is printed only after exact recovery-state verification.
Rollback emits either success claim only after exact temporary-image, reservation, private-workdir and
transaction-marker cleanup plus reservation-free whole-store validation and exact active-state proof.
Docker image identities are accepted only as one canonical `sha256:` plus 64 lowercase-hex line.
Only a successful empty exact-reference image probe proves absence. A timeout, daemon failure, or any
other error is indeterminate and fail-closed; immediately before exact-tag removal the helper rechecks
the canonical ID. A rebound/mismatched tag is preserved and the immutable ID is never a removal target.
One shared ordered
finalizer owns image, reservations, workdir, transaction marker and the operation-specific state proof,
without merging deploy publication/backup policy with rollback target semantics.
Cleanup is limited to the four recorded candidate paths; any identity mismatch, removal failure or store
proof failure retains/rewrites the recovery marker and suppresses the success claim.
Archive/sidecar final paths use atomic no-replace publication; identity-bound cleanup first moves the exact
entry into a private quarantine and never path-deletes a foreign replacement. Bounded output capture follows
the same private/no-replace ownership rule. Supervisor termination has a separate post-SIGKILL terminal bound:
unknown process-group probes, signal errors, a surviving group or a missing leader close/reap are explicit
fail-closed outcomes rather than an unbounded wait.
The retained source store admits at most four exact archive/sidecar pairs and 1 GiB and never auto-prunes;
the operator must manage a whole nonactive pair before another deploy when that bound is reached.

## PWA device coverage

The automated install/update/offline matrix uses local desktop Chromium at 320/375/768/1440 portrait and landscape.
Native splash appearance, standalone browser chrome, OS icon masks and safe-area behavior still need owner-approved
smoke checks on physical iPhone Safari and Android Chrome before a public rollout. The manifest, Paper A raster/SVG
icons, maskable safe zone, installability metadata and warm splash colors are verified locally; that evidence is not
a claim about every OEM launcher.
