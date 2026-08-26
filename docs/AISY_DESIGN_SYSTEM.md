# Aisy.space — design system foundation

Статус: канонический production-контракт направления **A — «Бумажный маршрут»**, 26 августа 2026 года

Исполняемый контракт: [`public/aisy-theme.css`](../public/aisy-theme.css)
Публичный тест: [`test/frontend-aisy-brand.test.js`](../test/frontend-aisy-brand.test.js)

## Бренд и язык

- Платформа и wordmark: **Aisy.space**, произношение по-русски — «Эйси».
- Текущий продукт: **Aisy ЕГЭ — Английский**.
- Голосовой помощник: **Ася**.
- Тон: спокойный, взрослый, конкретный. Ася не стыдит, не преувеличивает успех и не изображает
  уверенность там, где оценка приблизительная.
- Ученическая оболочка открывается только после серверного подтверждения активной подписки. UI не
  обещает бесплатный или демонстрационный доступ и не показывает checkout, пока отдельный платёжный
  контур не реализован.

Имена `EasyBoost*`, `easyboost:*`, `X-EasyBoost-*`, API-пути, ключи storage/database и значения
provenance остаются техническими контрактами. Их нельзя менять вслед за публичным wordmark.

## Визуальное направление

Тёплый «Бумажный маршрут»: cream-paper поверхности, plum-ink текст, один AA-safe dark-coral action
и редкие aqua/ochre смысловые акценты. Направление работает как аккуратный учебный стол, а не как
широкий dashboard: один portrait phone canvas `390px`, бумажные слои и вся глубина направлена вниз
и вправо. Эффекты объясняют состояние, а не украшают экран. На одном экране одна primary action;
структурные иконки — SVG с единым outline-языком, не emoji.

Абстрактный знак Аси — пересекающиеся голосовые волны в
[`public/pwa-icon.svg`](../public/pwa-icon.svg). Он не является человеческим аватаром или детским
маскотом. При встраивании через `<img>` нужен осмысленный `alt`; декоративная копия получает пустой
`alt` и `aria-hidden="true"`.

## Семантические цветовые токены

Компоненты используют только семантические токены. Hex-значения допустимы в теме, но не в новом
component CSS.

| Роль | Light | Dark | Назначение |
|---|---:|---:|---|
| Stage | `#fbe8df` | `#100c12` | фон вокруг телефонного canvas |
| Background | `#fff9f3` | `#171219` | фон телефона |
| Surface | `#fffdf9` | `#211a22` | карточки, sheets |
| Surface raised | `#fffdf9` | `#2a212b` | верхний бумажный слой |
| Surface muted | `#fff4ec` | `#302631` | вторичные области |
| Text | `#35263d` | `#fff9f3` | основной plum/cream текст |
| Text muted | `#665368` | `#dac9d4` | пояснения, не disabled text |
| Primary | `#b9433a` | `#b9433a` | единственный solid coral action |
| Primary hover | `#9f342f` | `#9f342f` | hover с сохранением AA |
| On primary | `#fffdf9` | `#fffdf9` | текст на primary |
| Accent | `#326b68` | `#83d8ac` | редкий aqua/AI accent |
| Goal | `#c56f22` | `#f2c574` | маршрутная цель |
| Border | `#9c7a91` | `#8f7185` | границы и разделители |
| Focus | `#6d365f` | `#f0a7d2` | keyboard focus ring |
| Success | `#256b4a` | `#83d8ac` | успех плюс текст/значок |
| Warning | `#845111` | `#f2c574` | предупреждение плюс текст/значок |
| Danger | `#9c302b` | `#ff9b91` | ошибка/destructive плюс текст/значок |

Канонические CSS-имена имеют префикс `--aisy-color-`. Основные пары текста проходят WCAG AA
`4.5:1`, focus ring — минимум `3:1` к фону; это вычисляет публичный test contract. Цвет не передаёт
результат в одиночку: рядом всегда есть текст, значок или форма/паттерн.

## Theme contract

- Без атрибута тема следует `prefers-color-scheme`.
- `data-theme="light"` на `<html>` фиксирует light.
- `data-theme="dark"` на `<html>` фиксирует dark.
- Новый экран не инвертирует отдельные hex-цвета: он потребляет тот же набор semantic tokens.
- `color-scheme` сообщает браузеру тему системных controls.

## Типографика

- Interface/body: `--aisy-font-interface` — Manrope с системными fallback.
- Дружелюбные заголовки и display numbers: `--aisy-font-friendly` — Nunito, затем Manrope.
- Body и inputs: минимум `16px`; рекомендуемый line-height `1.5–1.6`.
- Вес не заменяет структуру: один `h1`, последовательные уровни headings, настоящие labels.
- Основной learner canvas ограничивается `--aisy-content-width: 390px`; длинные legal/offline
  документы используют тот же читаемый предел.

Nunito и Manrope поставляются локальными variable WOFF2 с системными fallback; внешний font CDN и
Acrom без отдельной лицензии не используются.

## Геометрия и elevation

- Spacing: `4 / 8 / 12 / 16 / 20 / 24 / 28 / 32 / 48px`; основной ритм — 4 px.
- Minimum touch target: `--aisy-touch-target: 44px`; соседние controls разделяются минимум 8 px.
- Control radius: `16px`; card radius: `24px`; primary CTA radius: `28px`; phone radius: `36px`;
  pill: `999px`.
- Elevation: `--aisy-shadow-1` для карточек, `--aisy-shadow-2` для sheets/modals.
- Primary CTA буквально использует утверждённую анатомию `58 / 28 / 26 / 10 / 38`: высота,
  radius, left padding, right padding и cream affordance-circle. Label слева, стрелка справа;
  глубина только вниз-вправо.
- На широком viewport остаётся один центрированный телефон без side rail и без responsive
  растягивания внутренних экранов; учитываются safe areas и исключён horizontal overflow.

## Interaction и motion

- Видимый focus: outline `3px` через `--aisy-color-focus`, offset `3px`; focus ring не удаляется.
- Все click/tap controls используют семантические элементы и `touch-action: manipulation`.
- Disabled: native `disabled` или `aria-disabled="true"`, пониженная выразительность и отсутствие
  действия.
- Базовые component motion tokens: `180 / 220 / 420ms`, только transform/opacity/color/elevation и
  только когда движение объясняет изменение состояния. Первый запуск — намеренно ограниченное
  исключение: смена onboarding-страницы занимает `360ms` (в пределах `320–520ms`), линия логотипа —
  `520ms`, а спокойное появление logo/aura и минимальный splash hold — `620ms`; при reduced motion
  hold сокращается до `420ms`, движение исчезает.
- `prefers-reduced-motion: reduce` сводит animation/transition к `0.01ms` и отключает smooth scroll.
- Pressed/hover/focus состояния не меняют layout bounds.

## Базовые классы

| Класс | Интерфейс |
|---|---|
| `.aisy-document` | theme-aware page typography/background |
| `.aisy-reading-canvas` | bounded responsive long-form canvas |
| `.aisy-surface` | semantic card/sheet surface and elevation |
| `.aisy-button` | primary action with touch, hover, focus and motion states |
| `.aisy-mark` | stable dimensions for the Asya SVG mark |

Новый module должен получать максимум поведения из этих классов и token interface. Нельзя создавать
параллельный набор `screen-*` цветов, focus/motion или дублировать theme mapping в feature-файле.

## PWA, offline и privacy

`index.html`, `offline.html` и `privacy.html` подключают одну тему. Внешний CSP-safe
`theme-prepaint.js` применяет сохранённый light/dark/system выбор до первого stylesheet и входит в
service-worker closure вместе с `aisy-theme.css`, SVG-знаком, manifest и public documents. Offline copy не обещает работу
онлайн-only функций: уже загруженные материалы доступны в существующих границах, а Ася и ИИ-проверка
честно требуют подключения. Privacy copy называет внешнюю передачу, отдельные text/voice consent,
несохранение исходного аудио и ориентировочный характер ИИ-оценки.

## Проверка перед добавлением экрана

- Есть один primary CTA и понятные heading/label/async states.
- Controls не меньше 44×44 px; полный keyboard route и видимый focus.
- Light и dark пары проверены независимо, включая borders и states.
- Нет emoji как structural icons; SVG имеет accessible name, если несёт смысл.
- Обычный компонент использует шкалу `180 / 220 / 420ms` и имеет reduced-motion вариант; только
  зафиксированные выше opening-переходы используют `360 / 520 / 620ms`. Новая paper-route замена
  может оставить только opacity `100ms`.
- На `320×720 / 720×320`, `375×812 / 812×375`, `768×1024 / 1024×768` и
  `1440×900 / 900×1440` нет horizontal overflow; learner canvas остаётся телефонным.
- Offline/slow/error state ничего не выдают за свежий server result.
- Public copy использует Aisy.space / Aisy ЕГЭ — Английский / Ася, не переименовывая compatibility
  contracts.
