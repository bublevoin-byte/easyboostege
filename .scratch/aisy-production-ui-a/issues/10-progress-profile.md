# 10 — Завершить систему на Прогрессе и Профиле

**What to build:** Перенести Progress и Profile в A, чтобы ученик видел изменение/слабое место/следующий шаг,
управлял light/dark/system, мог повторить onboarding и безопасно выполнить privacy/export/delete/logout без
ложного Free-плана.

**Blocked by:** 03 — access check, Today и общая learner shell.

**Status:** done

**Spec anchor:** User Stories 18–19, 29–30, 31–36, 37–40, 49.

- [x] Progress ведёт с outcome delta, weak point и next action; графики имеют текстовые значения и пояснения.
- [x] Empty/loading/offline/error и assisted/independent evidence различимы без color-only meaning.
- [x] Profile группирует identity, preferences, access, privacy и account actions в ясной иерархии.
- [x] Theme selector `system | light | dark` применяется без reload, хранится и корректно инициализируется до paint.
- [x] «Повторить знакомство» открывает onboarding, а возврат не разрушает активную сессию.
- [x] Subscription copy отражает strict active access и не заявляет Free/demo или готовую оплату.
- [x] Export/delete/logout сохраняют подтверждение, focus management, owner reset и существующие server contracts.
- [x] Progress/profile/accessibility unit и browser tests проходят в обеих темах.

## Verification

- Независимые финальные Spec и Standards/A11y/Release reviews: ZERO findings на замороженном diff; строгий active-only доступ, owner-bound privacy/payment/export/delete/logout, replay onboarding и light/dark/system перепроверены отдельно.
- Focused Progress/Profile/access/theme/owner/static suite: 249/249 green; `git diff --check` green (кроме ожидаемых Windows CRLF notices).
- Production build: 533 verified assets; только известные предупреждения classic pre-paint script, существующего ineffective dynamic import и размера chunk.
- Chromium release contour: Paper A Progress/Profile, accessibility/responsive/offline, learner release, first launch + local VK ID и полный demo flow — green. Детерминированная bootstrap-race регрессия удерживает начальный `/progress`; полный demo дополнительно прошёл на трёх последовательных fresh ports.
- Canonical CTA сохраняет 58/28/26/10/38 anatomy и точное accessible name: cream affordance и стрелка построены без generated text и gradient component layers.
- Обязательная pre-commit цепочка выполнена ровно один раз: `npm run lint` green; `npm run check` green (508 JavaScript files, 165 разрешённых inline handlers / 105 имён); `npm test` — 2136 total, 2085 pass, 0 fail, 51 intentional skips.
- Deploy не выполнялся; release/PWA activation остаётся Ticket 11.
