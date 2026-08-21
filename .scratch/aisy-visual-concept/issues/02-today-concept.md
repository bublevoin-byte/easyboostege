# 02 — Собрать интерактивный визуальный концепт Today

Status: ready-for-agent
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
- Не входят production Today, service-worker app shell, backend, Progress, Asya и EGE implementation.

## Файлы

- `public/prototypes/today-v1/` — HTML/CSS/ES module и локальный оригинальный asset.
- `scripts/serve-today-prototype.js` и `package.json` — одна команда запуска.
- `.scratch/aisy-visual-concept/previews/` — проверенные preview screenshots.
- `.scratch/aisy-visual-concept/issues/02-today-concept.md` и `PROGRESS.md` — итоговый статус.

## Definition of Done

- [ ] Три варианта различаются структурой, а не только цветом.
- [ ] `?variant=A|B|C`, клики и стрелки клавиатуры переключают URL-stable вариант.
- [ ] Все варианты используют один data fixture и один token contract.
- [ ] Controls не меньше 44 px, focus видим, no overflow на 320/375/768/1440.
- [ ] Light/dark и reduced motion сохраняют смысл и контраст.
- [ ] В концепте нет structural emoji, stock-photo, paid/provider/network call.
- [ ] Production Today и app-shell closure не изменены.
- [ ] Локальная команда запуска и пути preview указаны в handoff.
- [ ] `npm run lint`, `npm run check`, focused production Today и frontend build проходят.
- [ ] `npm test` проходит.
- [ ] Один коммит на тикет.
