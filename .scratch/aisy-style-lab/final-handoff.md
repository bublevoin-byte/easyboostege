# Aisy Style Lab — handoff для выбора стилистики

**Статус:** готово к выбору владельца. Это approval-прототип; production UI не изменён.

## Что открыть

- Сравнение экранов:
  `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=today&state=ready&panel=flow`
- Чистый лист решения:
  `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=today&state=ready&panel=decision`
- Визуальная история первого запуска:
  `http://127.0.0.1:4319/prototypes/aisy-style-lab/opening.html`
- Кнопочная система A:
  `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=a&screen=progress&state=ready&panel=components`
- Кнопочная система B:
  `http://127.0.0.1:4319/prototypes/aisy-style-lab/index.html?direction=b&screen=progress&state=ready&panel=components`

Review-обёртка постоянно сообщает, что VK — визуальный placeholder и backend авторизации не подключён; sticky
disclosure остаётся видимым даже когда фокус прокручивает wrapper к шагу входа. Сам существующий
logo/onboarding/login прототип внутри неё не изменяется.

Верхняя панель переключает A/B/C, четыре одинаковых учебных экрана, общие компоненты, signature-анимации и
лист решения. Ученический интерфейс всегда остаётся одним портретным телефоном; reviewer toolbar находится
снаружи и не является частью PWA.

## Три основы

- **A — Бумажный маршрут:** самое прямое продолжение логотипа/onboarding; спокойные бумажные слои и ясная
  системность.
- **B — Тактильные виджеты:** наиболее предметный и игровой вариант; физичный seat/release отклик, но без
  dashboard-сетки.
- **C — Сюжетный маршрут:** самый эмоциональный вариант; четыре ориентира, прорисовка пути и продолжение после
  Progress.

Во всех направлениях одинаковы данные, порядок `Today → Task → Review → Progress`, один primary action и пять
нижних разделов `Сегодня / Практика / ЕГЭ / Прогресс / Профиль`.

## Правило решения

1. Выбрать ровно одну основу: A, B или C.
2. При желании выбрать максимум две конкретные механики из двух других направлений.
3. Не создавать четвёртый смешанный концепт до этого решения.

Лист решения сам удаляет same-base механику, дубликаты, неизвестные значения и всё сверх лимита 2. Выбор
записывается в URL и переживает reload. Предзаполненные QA-ссылки — только пример работы ограничения, не решение
владельца.

### Запись решения владельца

- Основа: **ожидает выбора**.
- Заимствование 1: **не выбрано**.
- Заимствование 2: **не выбрано**.
- Отклонённые полные направления: заполняются после выбора основы.

## QA-передача

- Foundation: `ПРОЙДЕНО ×3`, round 22.
- A: `ПРОЙДЕНО ×3`, round 7.
- B: `ПРОЙДЕНО ×3`, round 4.
- C: `ПРОЙДЕНО ×3`, round 2.
- Финальное comparison/decision/opening: `ПРОЙДЕНО ×3`, round 3.
- Кнопочная система A/B по onboarding/widget references: `ПРОЙДЕНО ×3`, round 3.
- Primary/deep/disabled сохраняют `58 / 28 / 26 / 10 / 38`; secondary/duration/choice — raised keys, B selected
  — sunken key без dominant outline. Button matrix: `24/24`; selected regression: `2/2`.
- 26 настоящих PNG рендеров находятся в `final-renders/`; размеры только `390×844` и `360×720`.
- 24 flow-комбинации на двух телефонах и 15 settled journey-состояний прошли без горизонтального overflow,
  side rail, потерянного CTA, неверного dock/nav или focus-разрыва.
- Static QA, lint, syntax/inline-handler check, полный unit-набор и diff-check зелёные. Подробные числа — в
  `final-qa.json`.

## Контракты, которые остаются для production-этапа

- выбрать и реализовать реальный VK/Telegram/другой authentication backend;
- согласовать prototype-длительности `10/20/30/40` с production composer `15–120`;
- перенести выбранную тему в production router/shell без возврата desktop side rail;
- оптимизировать и подтвердить права на raster assets onboarding;
- после выбора основы составить отдельный production migration plan, не смешивая его с approval-прототипом.
- отдельно утвердить production-accessibility ramp для coral CTA: текущий approval-прототип буквально сохраняет
  светлый текст и gradient из визуального эталона.
