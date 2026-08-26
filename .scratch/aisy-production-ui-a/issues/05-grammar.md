# 05 — Перенести грамматику в рабочие бумажные листы

**What to build:** Оформить grammar catalog, adaptive recommendation, активный runner и разбор в направлении A,
сохранив все темы, mixed practice, mastery и явную отправку ответа.

**Blocked by:** 03 — access check, Today и общая learner shell.

**Status:** done

**Spec anchor:** User Stories 16, 20, 26–28, 31–36, 40, 48.

- [x] Catalog/recommendation/start/resume/task/review/result/loading/error имеют общие hero, sheets, choices и dock.
- [x] Selection не отправляет ответ автоматически; submitted correct/incorrect и reusable rule читаются текстом и формой.
- [x] Tenses, verb constructions, parts of speech, function words и mixed/adaptive routes сохраняют domain contract.
- [x] Mastery/progress indicators содержат подписи и не зависят только от цвета.
- [x] Keyboard radio navigation, focus handoff, live feedback и reduced motion работают в основном контуре.
- [x] Малые телефоны и landscape сохраняют вопрос, варианты и CTA без перекрытия.
- [x] Grammar unit/E2E остаются зелёными и проверяют новое observable UI.

## Evidence

- Direction A Grammar использует один phone-only paper route, общие `.aisy-choice` / secondary controls и
  безопасный dock с утверждённой CTA-анатомией. Реальный Chromium зелёный на `320×720`, `720×320`, `375px`
  и desktop-stage: keyboard radios, explicit submit/Next, focus, light/dark, reduced motion, offline resume и
  queued reconnect.
- Targeted/recommendation, AI supplement, Voice Tutor и exam error-bank связаны с captured owner/generation;
  expected/response owner проверяются до private write/render. A→B, route-leave, mismatch и middleware-order
  regression покрыты детерминированными тестами.
- Focused gates: Grammar/security `63/63`, HTTP smoke `1/1`, AI owner boundary `1/1`; после единственного полного
  `npm test` устаревший exact-class selector был обновлён и точечно прошёл `1/1` (полный suite не перезапускался).
  Targeted lint, `check` (`493` JS / `189` inline handlers), frontend build (`528` assets), diff-check и
  независимые Spec/Standards re-review — `ZERO_FINDINGS ×2`.
