# Aisy.space — design system foundation

Статус: принято для learner UX redesign

Исполняемый контракт: [`public/aisy-theme.css`](../public/aisy-theme.css)
Публичный тест: [`test/frontend-aisy-brand.test.js`](../test/frontend-aisy-brand.test.js)

## Бренд и язык

- Платформа и wordmark: **Aisy.space**, произношение по-русски — «Эйси».
- Текущий продукт: **Aisy ЕГЭ — Английский**.
- Голосовой помощник: **Ася**.
- Тон: спокойный, взрослый, конкретный. Ася не стыдит, не преувеличивает успех и не изображает
  уверенность там, где оценка приблизительная.
- Публичные планы: **Free** и **Premium**. Внутренний `base` не является третьим публичным планом.

Имена `EasyBoost*`, `easyboost:*`, `X-EasyBoost-*`, API-пути, ключи storage/database и значения
provenance остаются техническими контрактами. Их нельзя менять вслед за публичным wordmark.

## Визуальное направление

Mature modern EdTech: ясная иерархия, спокойный индиго как основной цвет, тихие лавандовые
поверхности и сдержанный cyan-акцент. Эффекты объясняют состояние, а не украшают экран. На одном
экране одна primary action; структурные иконки — SVG с единым outline-языком, не emoji.

Абстрактный знак Аси — пересекающиеся голосовые волны в
[`public/pwa-icon.svg`](../public/pwa-icon.svg). Он не является человеческим аватаром или детским
маскотом. При встраивании через `<img>` нужен осмысленный `alt`; декоративная копия получает пустой
`alt` и `aria-hidden="true"`.

## Семантические цветовые токены

Компоненты используют только семантические токены. Hex-значения допустимы в теме, но не в новом
component CSS.

| Роль | Light | Dark | Назначение |
|---|---:|---:|---|
| Background | `#f7f7fc` | `#11121f` | фон страницы |
| Surface | `#ffffff` | `#1b1d2d` | карточки, sheets |
| Surface muted | `#efeff9` | `#25283c` | вторичные области |
| Text | `#15162a` | `#f5f5fa` | основной текст |
| Text muted | `#575b74` | `#c4c7da` | пояснения, не disabled text |
| Primary | `#5846c7` | `#aa9bff` | primary action, selected state |
| On primary | `#ffffff` | `#17112f` | текст на primary |
| Accent | `#0d7189` | `#74d3f2` | редкий AI/voice accent |
| Border | `#b7bacd` | `#62677f` | границы и разделители |
| Focus | `#0b73e0` | `#68b5ff` | keyboard focus ring |
| Success | `#1f6f4a` | `#64d69b` | успех плюс текст/значок |
| Warning | `#8a5100` | `#f4c46a` | предупреждение плюс текст/значок |
| Danger | `#b42318` | `#ff8c87` | ошибка/destructive плюс текст/значок |

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
- Длинный текст ограничивается `--aisy-content-width: 720px`.

Новых font-запросов и font-зависимостей этот foundation не добавляет.

## Геометрия и elevation

- Spacing: `4 / 8 / 12 / 16 / 24 / 32 / 48px`; основной ритм — 8 px.
- Minimum touch target: `--aisy-touch-target: 44px`; соседние controls разделяются минимум 8 px.
- Control radius: `14px`; card radius: `22px`; pill: `999px`.
- Elevation: `--aisy-shadow-1` для карточек, `--aisy-shadow-2` для sheets/modals.
- Desktop: bounded reading canvas; mobile: safe-area padding и отсутствие horizontal overflow.

## Interaction и motion

- Видимый focus: outline `3px` через `--aisy-color-focus`, offset `3px`; focus ring не удаляется.
- Все click/tap controls используют семантические элементы и `touch-action: manipulation`.
- Disabled: native `disabled` или `aria-disabled="true"`, пониженная выразительность и отсутствие
  действия.
- Motion durations: `160 / 240 / 300ms`, только transform/opacity/color/elevation и только когда
  движение объясняет изменение состояния.
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

`index.html`, `offline.html` и `privacy.html` подключают одну тему. `aisy-theme.css`, SVG-знак,
manifest и public documents входят в service-worker app shell. Offline copy не обещает работу
онлайн-only функций: уже загруженные материалы доступны в существующих границах, а Ася и ИИ-проверка
честно требуют подключения. Privacy copy называет внешнюю передачу, отдельные text/voice consent,
несохранение исходного аудио и ориентировочный характер ИИ-оценки.

## Проверка перед добавлением экрана

- Есть один primary CTA и понятные heading/label/async states.
- Controls не меньше 44×44 px; полный keyboard route и видимый focus.
- Light и dark пары проверены независимо, включая borders и states.
- Нет emoji как structural icons; SVG имеет accessible name, если несёт смысл.
- Motion укладывается в 150–300 ms и имеет reduced-motion вариант.
- На 320/375/768/1440 px нет horizontal overflow; desktop canvas не растянут.
- Offline/slow/error state ничего не выдают за свежий server result.
- Public copy использует Aisy.space / Aisy ЕГЭ — Английский / Ася, не переименовывая compatibility
  contracts.
