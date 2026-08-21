# Aisy.space — Coral Editorial Intelligence

Статус: кандидат для визуального концепта; production adoption не утверждён

Исполняемый кандидатный контракт:
[`public/prototypes/today-v1/visual-tokens.css`](../public/prototypes/today-v1/visual-tokens.css)

Принятая production foundation по-прежнему описана в
[`docs/AISY_DESIGN_SYSTEM.md`](AISY_DESIGN_SYSTEM.md). Этот документ не заменяет `public/aisy-theme.css`,
не меняет production Today и не утверждает, что Aisy v2 уже выпущена.

## Идея системы

**Coral Editorial Intelligence** — взрослый узнаваемый язык для Aisy.space: тёплый холст (warm
canvas), избирательная коралловая энергия, крупная редакционная композиция и спокойный учебный
интерфейс. Визуальная выразительность помогает выбрать следующий шаг, но не конкурирует с заданием и
не превращает подготовку к экзамену в игровую витрину.

Пять опор направления:

1. **Тёплая ясность.** Почти бумажный canvas и чернильный ink создают спокойную базу вместо
   стерильного белого или сплошной цветной заливки.
2. **Коралл по смыслу.** Coral energy ведёт к главному, а deep coral предназначен для primary action.
3. **Редакционная иерархия.** Editorial display выводит один тезис или число вперёд, calm interface
   type сохраняет читабельность объяснений, labels и заданий.
4. **Доверие к данным.** Verified teal означает подтверждённый результат только вместе с текстом,
   значком или формой. График никогда не просит расшифровывать цвет без подписи.
5. **Особый момент Аси.** Asya violet и более глубокая атмосфера появляются контекстно, а не
   становятся вторым primary-цветом обычной навигации.

## Архитектура токенов

Контракт следует цепочке **primitive → semantic → component**.

| Слой | Ответственность | Правило изменения |
|---|---|---|
| Primitive | Сырые hex, размеры, интервалы, радиусы, длительности и семейства шрифтов | Меняется редко и только после проверки всей темы |
| Semantic | Роли canvas, ink, action, verified, Asya, chart, focus, light/dark и intensity | Переназначается при смене темы или контекста |
| Component | Button, surface, chart, Asya moment, strict EGE surface и study object | Ссылается только на semantic aliases, без raw hex |

CSS Layers объявлены в фиксированном порядке: `aisy-v2-primitives`, `aisy-v2-semantic`,
`aisy-v2-components`. Prototype-компоненты получают префикс `.aisy-v2-`, чтобы кандидат не создавал
неявный production contract.

Raw hex разрешён только в primitive layer. Semantic layer связывает светлые и тёмные primitives через
`light-dark()`. Component layer и component recipes используют только `var(...)`; копировать туда
палитру или создавать экранные `today-*` цвета нельзя.

## Палитра и роли

| Семантическая роль | Light | Dark | Назначение |
|---|---:|---:|---|
| Canvas | `#fff8f2` | `#171211` | Тёплый фон композиции |
| Surface | `#fffdf9` | `#211a18` | Основная flat tonal surface |
| Surface coral | `#ffe9df` | `#432822` | Мягкая эмоциональная область, не action |
| Ink | `#211816` | `#fff7f2` | Основной текст |
| Ink muted | `#66524e` | `#d8c3bc` | Пояснения и метаданные, не disabled text |
| Coral energy | `#e85d4a` | `#ff9a88` | Большая форма, маркер маршрута, редкий accent |
| Action / deep coral | `#b5332b` | `#ff9a88` | Единственный primary CTA экрана |
| On action | `#fffdf9` | `#211816` | Текст и glyph на primary CTA |
| Asya violet | `#6e43bf` | `#c5adff` | Контекст Аси и special moment |
| Verified teal | `#076b63` | `#67d9ca` | Подтверждённая evidence, всегда с label/shape |
| Border strong | `#9d7770` | `#94756c` | UI boundaries и разделители |
| Focus | `#176b87` | `#70d7ed` | Keyboard focus ring |

Coral energy может быть декоративной крупной плоскостью и не обязана нести мелкий текст. Для текста
и интерактивного chart series используются пары Action / On action или Chart primary, прошедшие
отдельную contrast-проверку. Warning и danger остаются отдельными semantic roles и никогда не
заменяются кораллом бренда.

### Три уровня коралловой интенсивности

Проценты — композиционная оценка видимой площади, а не runtime pixel-test:

| Режим | Доля кораллового | Где применять | Чего не делать |
|---|---:|---|---|
| Expressive | **15–25%** | Today hero, onboarding, результат крупного шага | Не красить все карточки и фон страницы |
| Working | **5–12%** | Practice, Progress, каталоги и учебные hubs | Не превращать каждый action в primary |
| Strict EGE | **2–5%** | Заголовок, текущая позиция, один start/submit accent | Не конкурировать с экзаменационным материалом |

Количество primary CTA не зависит от уровня: на экране остаётся одна визуально главная action.

## Типографика

- **Editorial display:** локальный `Nunito` с `Manrope` и системными fallback. Он используется для
  одного крупного заголовка, editorial statement или display number; tight line-height `1.08` и
  отрицательный tracking допустимы только на этом уровне.
- **Calm interface:** локальный `Manrope`, затем системный sans-serif. Body, controls и inputs — не
  меньше `16px`, line-height body — `1.6`.
- Display scale ограничена `clamp(2.75rem, 12vw, 6.5rem)`, поэтому большое число становится частью
  композиции, но не создаёт horizontal overflow на телефоне.
- Числа в charts, rhythm и countdown используют tabular figures. Вес шрифта усиливает, но не заменяет
  правильные headings, labels и reading order.
- Никакого внешнего font request: кандидат опирается на уже доступные product families и системные
  fallback.

## Геометрия, поверхности и elevation

- Основной spacing rhythm — `4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48 px`; соседние controls
  разделяются минимум на `8px`.
- Flat tonal surfaces используют радиусы **20–28 px**: `20px` для controls, `24px` для cards и
  `28px` для hero/composition objects.
- Большинство surfaces имеют `box-shadow: none`. Единственная системная soft shadow применяется к
  floating evaluation control, modal или маленькому soft 3D object, где нужно отделение от canvas.
- Граница — смысловой способ разделения; её light и dark варианты дают не меньше `3:1` относительно
  основной surface.
- Desktop composition ограничена `1180px`, длинное чтение — `720px`. На мобильных учитываются safe
  area и content gutter, а fixed controls не перекрывают материал.

## Иллюстрации и объекты

Визуальный язык — **hybrid abstract editorial + small soft 3D study objects**:

- abstract editorial формы задают ритм, направление маршрута и место для крупного числа;
- small soft 3D objects — нейтральные учебные предметы вроде карточки, карандаша или мягкого letter
  block без текста, logo, watermark и узнаваемого персонажа;
- объект поддерживает смысл секции и не является кнопкой без настоящего control/label;
- исходный raster asset должен быть project-bound, иметь заданные dimensions/aspect-ratio и не
  вызывать layout shift;
- structural icons остаются единым SVG outline-набором с доступным именем там, где иконка значима.

Направление работает **без маскотов**, без structural emoji и **без стоковых фотографий учеников**.
Лица и знакомые рекламные сцены не заменяют собственный визуальный мир Aisy.

## Component handoff

| Component token group | Семантика | Обязательный контракт |
|---|---|---|
| Canvas | warm canvas + ink | `100dvh`, bounded composition, no overflow |
| Surface | surface + ink + border | flat by default, radius `24px` |
| Button | action + on-action | один primary CTA, stable bounds, pressed feedback |
| Duration choice | surface/action state | real button, selected text/attribute, 44×44 px |
| Chart | chart primary/violet/verified + grid + ink label | direct labels, visible summary, data fallback |
| Asya moment | neutral/deep surface + Asya violet | contextual special cue, не global navigation theme |
| EGE surface | surface + ink + border + restrained action | 2–5% coral, task remains dominant |
| Study object | surface coral + coral energy + rare float shadow | decorative or properly named, reserved dimensions |

New prototype components must consume these component tokens. Feature CSS may arrange layout, but cannot
redeclare palette, theme mapping, focus, touch target or motion duration.

## Charts и evidence

- Графики имеют видимый title, единицы измерения, direct labels или legend рядом с данными и краткий
  текстовый summary с главным выводом.
- Progress rhythm для семи дней показывает подпись дня и точное число/состояние; цвет не является
  единственным носителем регулярности.
- Independent, assisted и approximate evidence различаются label, glyph/shape или pattern, а не
  red/green pair.
- Data stroke/fill относительно surface проходит минимум `3:1`; normal text labels — `4.5:1`.
- Interactive point/bar имеет реальную keyboard route и hit area **44×44 px** либо расширенную touch
  область. Tooltip доступен по focus/tap, а не только по hover.
- Для screen reader рядом доступно резюме или table/list с теми же значениями. Empty/loading/error
  состояния содержат объяснение и recovery, а не пустую ось.
- Chart reveal может объяснить последовательность один раз; данные и labels читаются сразу и без
  анимации.

## Asya special moment

Asya violet резервируется для контекстного обращения к Асе. Полная будущая conversation surface может
использовать глубокий canvas и редкие particles, но обычный Today показывает лишь небольшую cue-card или
outline. Continuous ambient motion допустим только внутри явно открытого special moment, максимум для
одного слоя, и прекращается при `prefers-reduced-motion`.

Фиолетовый не маркирует Premium, selected navigation или обычный primary action. Ася не изображается
человеком, mascot или говорящим персонажем; абстрактная voice/particle geometry остаётся взрослой и
не антропоморфной.

## Строгий ЕГЭ

На строгой поверхности ЕГЭ главное — формулировка, таймер, позиция, answer field и явный submit. Режим
использует **2–5%** коралла: небольшой position marker, focus/selection cue или один start/submit action.
Canvas и task surfaces остаются нейтральными, display typography не попадает внутрь текста задания, а
soft 3D objects и ambient motion убираются из рабочего поля. Warning/danger показывают значение текстом,
не бренд-кораллом.

## Motion

Принцип: **fast response + soft continuation**.

- Response `160ms` даёт hover/pressed feedback без изменения layout bounds.
- Continuation `240ms` связывает смену выбранной длительности или локального state.
- Reveal `300ms` показывает направление route/chart и применяется максимум к одному-двум элементам.
- Анимируются только `transform`, `opacity`, color/filter/elevation; width, height, top и left не
  анимируются.
- Motion выражает причину и следствие. Decorative looping на обычных учебных экранах запрещён.
- При `prefers-reduced-motion: reduce` animation/transition сокращаются до `0.01ms`, route/chart сразу
  находятся в конечном читаемом состоянии, smooth scroll и ambient particles отключены.

## Responsive и темы

- Проверочные widths: **320 / 375 / 768 / 1440 px**; ни на одном нет horizontal overflow.
- Mobile first: core recommendation идёт раньше вторичного context, controls не ужимаются меньше
  minimum touch target, text wraps before truncation.
- На desktop композиция становится bounded editorial canvas, а не растянутым phone layout.
- `data-theme="light"` и `data-theme="dark"` устанавливают `color-scheme`; без атрибута работает
  `prefers-color-scheme`.
- Dark mode — отдельная tonal mapping с более светлым кораллом, violet и teal, а не инверсия light
  hex. Contrast проверяется независимо.

## Accessibility gates

- Normal text и action labels: contrast не меньше **4.5:1** в light и dark.
- UI boundaries, data graphics и visible focus: contrast не меньше **3:1** к соседней surface/canvas.
- Все controls — минимум **44×44 px**, между соседними targets — минимум `8px`; используется
  `touch-action: manipulation`.
- `:focus-visible` использует outline `3px` и offset `4px`; focus ring не удаляется и не заменяется
  только тенью.
- Color never acts alone: selected, verified, warning, error и evidence получают label, state/glyph или
  pattern.
- Meaningful SVG получает accessible name, декоративный объект скрывается от accessibility tree.
- Semantic buttons/links/fields сохраняют keyboard order; disabled state использует native `disabled`
  или `aria-disabled="true"` и не выполняет действие.
- Text scaling и wrapping не скрывают CTA, labels или chart summary.

### Проверенные критические пары

| Пара | Light | Dark | Порог |
|---|---:|---:|---:|
| Ink / canvas | 16.54:1 | 17.54:1 | 4.5:1 |
| Ink muted / surface | 7.17:1 | 10.16:1 | 4.5:1 |
| On action / action | 5.95:1 | 8.48:1 | 4.5:1 |
| Asya violet / surface | 6.42:1 | 8.81:1 | 4.5:1 |
| Verified teal / surface | 6.28:1 | 10.08:1 | 4.5:1 |
| Border strong / surface | 3.90:1 | 4.10:1 | 3:1 |
| Focus / canvas | 5.72:1 | 11.17:1 | 3:1 |

Публичный test contract вычисляет ratios из primitive values, а не доверяет этой таблице.

## Граница прототипа и путь принятия

- Candidate CSS подключается только локальной страницей `public/prototypes/today-v1/`; production
  HTML, Today modules и routes не импортируют его.
- Prototype не входит в PWA application shell; service worker его **не** кэширует и не получает
  новый URL в precache.
- Кандидат не добавляет network/provider calls, remote fonts, analytics, storage writes или package
  dependency.
- После выбора владельцем winning decisions переписываются в production contract отдельным тикетом,
  проходят light/dark/browser/accessibility gates и только затем могут заменить indigo foundation.
- Losing prototype layouts и временные component recipes не переносятся в main как скрытая вторая UI
  система.
