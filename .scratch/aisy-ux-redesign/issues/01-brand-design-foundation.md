# 01 — Бренд и дизайн-фундамент Aisy

Status: done
Blocked by: —
Spec: `.scratch/aisy-ux-redesign/spec.md#3-product-architecture`

## Что сделать

Заменить публичную идентичность Easy Boost на Aisy.space / Aisy ЕГЭ — Английский и ввести один
семантический набор light/dark токенов, типографики, фокуса, touch targets, elevation и motion, на который
смогут опираться следующие экраны.

## Границы

- Входит public copy в оболочке, PWA manifest/offline/privacy и доступный абстрактный SVG-знак Аси.
- Входит отдельный design-system документ и executable frontend contract.
- Не входят переименование `EasyBoost*`, API, headers, storage/database keys и content provenance.
- Не входят новая навигация и перестройка экранов.

## Файлы

- `docs/AISY_DESIGN_SYSTEM.md` — source of truth для токенов и компонентов.
- `public/aisy-theme.css` — семантические токены и общие состояния.
- `public/index.html`, `public/manifest.json`, `public/offline.html`, `public/privacy.html`, `public/privacy.js`,
  `public/pwa-icon.svg`, `public/pwa.js` — публичный бренд без изменения технических контрактов.
- `public/service-worker.js`, `public/main.js` — подключение и offline closure.
- `test/frontend-aisy-brand.test.js` — публичный RED/GREEN contract.

## Definition of Done

- [ ] Публичные surfaces последовательно показывают Aisy.space / Aisy ЕГЭ — Английский / Ася.
- [ ] Light/dark tokens, visible focus, reduced motion и 44 px minimum закреплены тестом.
- [ ] Структурные иконки не используют emoji.
- [ ] Внутренние EasyBoost contracts не переименованы.
- [ ] `npm test`, `npm run lint`, `npm run check`, `npm run build:frontend` проходят.
- [ ] Один коммит на тикет: `feat(aisy): establish brand and design foundation`.
