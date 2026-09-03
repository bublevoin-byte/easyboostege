# Aisy Style Lab · кнопочная система A/B · круг 3

Судить только актуальные PNG в `button-renders/round3/`. Круги 1–2 устарели.

## Единственный блокер круга 2 и исправление

У selected choice направления B доминировал фиолетовый outline, поэтому клавиша читалась плоской. В актуальном
рендере selected использует ту же мягкую кромку, что default keys, более выраженный внутренний sunken-shadow и
физическую посадку на `2px`; выбор остаётся видимым через лавандовую поверхность и заполненный marker.

## Точные рендеры

- `button-renders/round3/a-components-390x844.png`
- `button-renders/round3/b-components-390x844.png`
- `button-renders/round3/a-task-360x720.png`
- `button-renders/round3/b-task-360x720.png`

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

- Базовая A/B matrix остаётся `24/24`, failures `0`; актуальная selected-key regression отдельно проходит на
  `360×720` и `390×844`: border matches default key, inset true, clip false, overflow `0`, inside true.
- Static QA теперь защищает raised B choices, muted disabled orb и selected без dominant outline.
- Focused lint, syntax/inline-handler check и `git diff --check` зелёные.
- Production UI, API, storage и service worker не затронуты.

## Требуемый вердикт

Вернуть `PASS` или `FAIL` и один самый большой видимый блокер. Любой `FAIL` требует нового круга.
