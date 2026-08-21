# 01 — Зафиксировать будущую визуальную систему Aisy v2

Status: done
Blocked by: —
Spec: `.scratch/aisy-visual-concept/spec.md#solution`

## Что сделать

Оформить кандидатную систему **Coral Editorial Intelligence** как понятный дизайн-документ и
исполняемый трёхслойный token contract, не выдавая её за уже внедрённую production-тему.

## Границы

- Входят палитра, типографика, геометрия, поверхности, иллюстрации, интенсивность кораллового,
  charts, motion, Asya special moment, strict EGE restraint, responsive и accessibility правила.
- Входит публичная проверка структуры токенов и критических contrast-пар.
- Не входит изменение production-компонентов или действующего `public/aisy-theme.css`.

## Файлы

- `docs/AISY_VISUAL_SYSTEM_V2.md` — будущая система и handoff-правила.
- `public/prototypes/today-v1/visual-tokens.css` — primitive → semantic → component токены концепта.
- `test/frontend-aisy-visual-system-v2.test.js` — внешний contract будущей системы.
- `scripts/build-frontend.js` и `test/frontend-offline-contract.test.js` — preview assets копируются
  в build, но не становятся частью executable offline app shell.
- `.scratch/aisy-visual-concept/` и `PROGRESS.md` — статус Autopilot-цикла.

## Definition of Done

- [x] Будущая система отделена от принятого production foundation.
- [x] Три token-слоя присутствуют и компоненты не используют raw hex.
- [x] Критические light/dark пары проходят WCAG AA, focus — минимум 3:1.
- [x] Зафиксированы touch 44 px, reduced motion и три уровня coral intensity.
- [x] Preview assets исключены из service-worker app shell без ослабления production closure.
- [x] Публичный focused test проходит.
- [x] `npm run lint` и `npm run check` проходят.
- [x] `npm test` проходит: 1866 pass, 48 штатных PostgreSQL skip, 0 fail.
- [x] Один коммит на тикет.
