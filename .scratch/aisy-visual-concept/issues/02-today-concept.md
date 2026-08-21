# 02 — Собрать интерактивный визуальный концепт Today

Status: done
Blocked by: 01 — Зафиксировать будущую визуальную систему Aisy v2
Spec: `.scratch/aisy-visual-concept/spec.md#solution`

## Что сделать

Создать отдельный локальный Today-прототип с одинаковыми правдивыми данными и тремя радикально
разными композициями A/B/C, чтобы владелец мог сравнить и выбрать визуальную иерархию до изменения
рабочего экрана.

## Границы

- Входят `Coral Route`, `Living Canvas`, `Progress Pulse`, URL-переключатель, keyboard arrows,
  light/dark/reduced-motion, 320–1440 px, оригинальный мягкий 3D study-object и preview screenshots.
- Входит одна команда локального запуска и явная маркировка `PROTOTYPE`.
- Прототип read-only, не пишет предпочтения и не вызывает product/provider API.
- Локальный runner читает prototype из source tree; production build и asset manifest полностью исключают
  `public/prototypes/**`.
- Не входят production Today, service-worker app shell, backend, Progress, Asya и EGE implementation.

## Файлы

- `public/prototypes/today-v1/` — HTML/CSS/ES module и локальный оригинальный asset.
- `scripts/serve-today-prototype.js` и `package.json` — одна команда запуска.
- `scripts/build-frontend.js` и `test/frontend-offline-contract.test.js` — узкая production-exclusion граница.
- `.scratch/aisy-visual-concept/previews/` — проверенные preview screenshots.
- `.scratch/aisy-visual-concept/issues/02-today-concept.md` и `PROGRESS.md` — итоговый статус.

## Definition of Done

- [x] Три варианта различаются структурой, а не только цветом.
- [x] `?variant=A|B|C`, клики и стрелки клавиатуры переключают URL-stable вариант.
- [x] Все варианты используют один data fixture и один token contract.
- [x] Controls не меньше 44 px, focus видим, no overflow на 320/375/768/1440.
- [x] Light/dark и reduced motion сохраняют смысл и контраст.
- [x] В концепте нет structural emoji, stock-photo, paid/provider/network call.
- [x] Production Today и app-shell closure не изменены.
- [x] Prototype отсутствует в production `dist` и asset manifest.
- [x] Локальная команда запуска и пути preview указаны в handoff.
- [x] `npm run lint`, `npm run check`, focused production Today и frontend build проходят.
- [x] `npm test` проходит.
- [x] Один коммит на тикет.
