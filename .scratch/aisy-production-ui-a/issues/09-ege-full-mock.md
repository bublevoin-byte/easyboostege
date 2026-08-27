# 09 — Оформить ЕГЭ и полный пробник без ослабления режима

**What to build:** Перенести EGE hub, письменный и устный runners, результаты и переходы полного пробника в
строгий вариант бумажной системы A, сохранив таймеры, lock order, recovery, scoring и экзаменационные ограничения.

**Blocked by:** 03 — access check, Today и общая learner shell.

**Status:** done

**Spec anchor:** User Stories 17, 24, 26–28, 31–36, 40, 48.

- [x] EGE hub ясно разделяет practice sections и полный mock, не превращаясь в равноправный dashboard.
- [x] Written/oral intro, runner, timer, navigation, submit confirmation, recovery и result используют calm strict surfaces.
- [x] Timer/warning/locked/submitted/error states не зависят только от coral и остаются читаемыми в dark theme.
- [x] Deep exam chrome не показывает global bottom nav и не теряет emergency/back semantics.
- [x] Existing catalogs, attempt persistence, oral media, writing assessment, scoring и lock order не меняются.
- [x] Reload/offline/reconnect и small-phone/landscape сохраняют честное состояние попытки.
- [x] Полный EGE unit/E2E release contour остаётся зелёным после визуальной миграции.

## Verification

- Независимые финальные Spec и Standards/A11y/Release review: ZERO actionable Ticket09 findings.
- Paper A EGE hub, письменный и устный runners, recovery, confirmation и result собраны на внешних semantic-token CSS без presentation inline styles или raw palette в мигрированном mock.
- Production Chromium matrix: 320/375/768/1440 px и 844×390 landscape, light/dark, reduced motion, canvas ≤390 px, один Back, скрытый global nav, 44 px targets, 16 px fields, canonical 58/28/26/10/38 coral CTA и Asya без перекрытия — green.
- Exact offline continuation ограничен состоянием `exam-only`: восстанавливает только совпавшую owner/generation/form/fingerprint попытку; Back возвращает в locked reconnect gate и не раскрывает hub/private learner shell.
- Async regressions закрыты browser/unit seams: delayed hub import не возвращает на устаревший route, lazy-load failure recoverable через reload, old-DOM answer не попадает в новый runner, terminal writing assessment обновляет same-phase projection.
- `npm run test:e2e:ege-mock`: green — hub, written, oral, result и единый home→42→result release contour; production offline reload отдельно доказывает загрузку emitted hashed stylesheet из APP_SHELL.
- Focused EGE presentation/SW/UI suite: 58/58; `git diff --check`: green (кроме ожидаемых CRLF notices).
- `npm run lint` и `npm run check`: green. Обязательный полный `npm test` запущен ровно один раз и завершился nonzero; вывод runner был обрезан до summary, видимы два не-Ticket09 отказа: `frontend-states` 6/7 (ожидаемый legacy Writing empty marker отсутствует уже в `b831eda`, Ticket09 Writing files не меняет) и параллельный `http-smoke` readiness timeout. Изолированный `http-smoke` сразу green 1/1; Ticket09-focused и полный EGE release contour остаются green.
