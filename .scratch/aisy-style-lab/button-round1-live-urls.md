# Aisy Style Lab · кнопочная система A/B · круг 1

Судить только актуальный видимый результат. Утверждённый CTA:
`C:/Users/4FE4~1/AppData/Local/Temp/codex-clipboard-ca46ca60-ec21-4da2-b318-7dc5bfd14022.png`.
Tactile widget-reference:
`C:/Users/Ригер/Downloads/92c25a71d74dd8ddb6b4d1298cb13ac8.jpg`.

## Точные рендеры

- `button-renders/round1/a-components-390x844.png`
- `button-renders/round1/b-components-390x844.png`
- `button-renders/round1/a-task-360x720.png`
- `button-renders/round1/b-task-360x720.png`

## Live URLs

- A · компоненты:
  `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=progress&state=ready&panel=components&carrier=canonical`
- B · компоненты:
  `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=b&screen=progress&state=ready&panel=components&carrier=canonical`
- A · задание:
  `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=task&state=ready&panel=flow&carrier=compact`
- B · задание:
  `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=b&screen=task&state=ready&panel=flow&carrier=compact`

## Измеримый контракт

- Primary/deep primary: `58px` высота, `28px` радиус, padding `26px / 10px`, affordance `38px`.
- Primary: коралловый градиент, левый label, кремовый круг справа и физическая тень из onboarding.
- Secondary/duration/choice: светлые raised keys; selected — sunken, без generic hard-outline treatment.
- Disabled сохраняет тот же силуэт и круг.
- Внешние viewport `415×760` и `445×884` дают внутренние телефоны ровно `360×720` и `390×844`.
- Динамическая матрица A/B × Today/Task/Review/Progress/Components/Resume × 2 размера: `24/24`, failures `0`.
- Horizontal overflow `0`; видимые action controls не меньше `44×44`; label clip/wrap `0`.
- Static QA, focused lint, syntax/inline-handler check и `git diff --check` зелёные.
- Production UI, API, storage и service worker не затронуты.

## Требуемый вердикт

Вернуть `PASS` или `FAIL` и только один самый большой видимый блокер. Любой `FAIL` запускает новый круг после
исправления.
