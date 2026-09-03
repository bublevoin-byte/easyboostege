# 07 — Перенести письмо, ожидание и AI-разбор

**What to build:** Оформить выбор письменного задания, редактор, отправку, ожидание и результат AI-проверки как
один последовательный paper route с честными limits/errors и сохранением введённого текста.

**Blocked by:** 03 — access check, Today и общая learner shell.

**Status:** done

**Spec anchor:** User Stories 16, 22–24, 26–28, 31–36, 40, 48.

- [x] Catalog/prompt/editor/sending/waiting/review/retry/result используют одну deep-screen композицию и один CTA.
- [x] Textarea, counters, validation, draft/saved state и focus labels доступны и визуально согласованы.
- [x] AI waiting, ready, recoverable error, quota/limit и offline состояния имеют точную копию и live announcements.
- [x] Review сначала показывает результат, затем исправление, правило, evidence и следующий шаг.
- [x] Existing writing facts, assessment request, draft/storage и owner authority semantics не меняются.
- [x] Клавиатура телефона, safe area и длинный feedback не перекрываются dock.
- [x] Writing/AI review unit и browser tests проходят с новым observable UI.

## Verification

- Focused backend/frontend Writing matrix: 294 events, exit 0; live PostgreSQL cases are conditional on
  `TEST_DATABASE_URL`, while shared file/PostgreSQL source contracts and migrations pass.
- Provider ambiguity/remediation gate: 87/87; successful-response body timeout, abort and invalid JSON cannot trigger
  an automatic paid repeat. Release-script contract: 3/3.
- `npm run lint`, `npm run check` and `npm run build:frontend`: exit 0; 531 assets and 24 lazy chunks verified.
- `npm run test:e2e:writing-paper`: exit 0 for the phone/landscape/desktop Paper matrix and production service-worker
  offline reload with lazy Writing assets and the exact multiline draft.
- Independent Spec and Standards re-reviews: `ZERO_FINDINGS` × 2.
- The one allowed full `npm test` run was not repeated. It exposed four Ticket-07-stale test expectations; focused
  fixes now pass 27/27 Voice Tutor tests and 2/2 semantic-label tests. One unrelated inherited
  `frontend-accessibility` assertion still counts literal `ui.markAnswer` calls: both this tree and `HEAD 48b935e`
  have zero calls because Ticket 05 replaced them with explicit text/glyph/live-status verdicts.

## Release dependency

- Серверный fail-closed version gate (`CLIENT_UPDATE_REQUIRED`) намеренно не поддерживает старый cached client без
  ExpectedOwner/Idempotency-Key: такой запрос гарантированно не меняет provider/quota/attempt/delivery state.
- До production deploy Ticket 11 обязан обеспечить controlled service-worker update/version activation, потому что
  уже открытая pre-Ticket07 страница сама может показать старый fabricated localReview после HTTP 428. Ticket 07 не
  ослабляет owner/exactly-once контракт и не реализует Ticket 11.
