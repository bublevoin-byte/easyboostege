# Aisy Style Lab · кнопочная система A/B · круг 2

Это полностью свежий рендер после двух блокеров круга 1. Судить только `button-renders/round2/` и текущие live
URLs; `round1` больше не является актуальным результатом.

## Закрытые блокеры круга 1

- B choices больше не используют сильный outline: default получает светлый gradient surface, мягкий raised shadow и
  общий `16px` key radius; selected получает sunken shadow и физическую посадку.
- Disabled primary сохраняет общий `58 / 28 / 26 / 10 / 38` силуэт; круг отделён светлым градиентом, мягкой
  кромкой и тенью, а chevron намеренно приглушён.

## Точные рендеры

- `button-renders/round2/a-components-390x844.png`
- `button-renders/round2/b-components-390x844.png`
- `button-renders/round2/a-task-360x720.png`
- `button-renders/round2/b-task-360x720.png`

## Live URLs

- A · компоненты:
  `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=progress&state=ready&panel=components&carrier=canonical`
- B · компоненты:
  `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=b&screen=progress&state=ready&panel=components&carrier=canonical`
- A · задание:
  `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=task&state=ready&panel=flow&carrier=compact`
- B · задание:
  `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=b&screen=task&state=ready&panel=flow&carrier=compact`

## QA актуального круга

- A/B × Today/Task/Review/Progress/Components/Resume × `360×720`/`390×844`: `24/24`, failures `0`.
- Horizontal overflow `0`; label clip/wrap `0`; один visible CTA на flow; action controls `≥44×44`.
- Primary/deep primary: `58px`, `r28`, `26/10px`, affordance `38px`.
- Static QA, focused lint, syntax/inline-handler check и `git diff --check` зелёные.
- Production UI, API, storage и service worker не затронуты.

## Требуемый вердикт

Вернуть `PASS` или `FAIL` и один самый большой видимый блокер. Любой `FAIL` требует нового рендера и ещё одной
полностью свежей тройки критиков.
