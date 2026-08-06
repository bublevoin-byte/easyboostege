# Reading 2.0 — release evidence

Дата локальной проверки: 2026-08-06. Ветка: `feature/reading-2-pilot`. Базовый commit тикета 08:
`d5e4bbb61d4afef11e021791d6f4db4cc1058832`.

## Фактический продуктовый контракт

- Любой вошедший пользователь с активной серверной подпиской получает весь основной Reading:
  замороженный каталог 60 оригинальных комплектов, три тренировки официального размера, полный
  раздел 10–18, историю, evidence-разбор, словарь, адаптивную запись и полезный Base-отчёт.
- Premium добавляет только Voice Tutor для конкретной ошибки и expanded report. Клиент не сообщает
  серверу entitlement: endpoint заново проверяет текущую активную подписку и `voice_tutor` право.
  Отзыв/истечение закрывают новый Voice и expanded report без stale-проекции; сетевой сбой остаётся
  отдельным неизвестным состоянием и не изображается как подтверждённый downgrade.
- Перед каждой новой отдельной, технической, полной или adaptive Reading-сессией общий access gate
  заново запрашивает `/api/v1/me`. Только `active: true` создаёт попытку; подтверждённый inactive и
  network-unknown закрывают/inert-ят учебную оболочку разными сообщениями. Кэш каталога не выдаёт
  разрешение на новый запуск; `/me` помечен `Cache-Control: no-store`, а timeout adaptive launch
  передаёт `AbortSignal` до самого `/me` fetch, освобождает launch-lock и не допускает поздней записи
  истории или отрисовки задания.
- Оба отчёта — детерминированная серверная проекция из не более 120 последних persisted owner-bound
  canonical Reading rows. Дубли, неполный полный раздел, technical fallback, generated и legacy
  строки исключаются. Малые выборки получают `insufficient_evidence`; корреляции по темам/CEFR не
  называются доказательством освоения или причинностью. Число самостоятельных попыток и попыток с
  поддержкой показывается отдельно; поддержка не скрывается из выборки.
- Успешный expanded payload не кэшируется в localStorage. Новый класс данных, миграция или платный
  runtime AI-вызов не появились; экспорт/удаление опираются на существующие `module_attempts`.

## Официальная рамка и честность

Сохранённая сверка первичных источников находится в
[official-format-research.md](../.scratch/reading-2-pilot/official-format-research.md). Интерфейс
показывает 7 из 8 соответствий в №10, 6 из 7 в №11, семь вопросов №12–18, 20 полей, 12 первичных
баллов и рекомендацию ФИПИ 30 минут без принудительного cutoff. Справка ФИПИ сообщает, что формат
КИМ-2026 по иностранным языкам не изменён относительно 2025 года.

Раскрываемая метка интерфейса: «Автоматически проверено». Disclosure: «Формат, ключи, количество
элементов и цитаты-доказательства проверены программно. Это оригинальный учебный материал Easy
Boost, не официальный вариант ФИПИ и не ручная проверка методистом».

Это подтверждает структурный автоматический контроль каталога, но не методическую экспертизу ФИПИ.
Ручная предметная сверка качества всех формулировок вне программных invariants остаётся человеческим
release gate; документ не заявляет, что она выполнена автоматически.

## Проверяемые gates

- Domain/unit contracts: deterministic aggregation, samples/confidence/insufficient states, no raw
  answer/content leakage, owner isolation, bounded file/PostgreSQL parity, active Base and current
  Premium entitlement, forged scope, revoke/expiry/inactive subscription.
- Signed Chromium: Base получает весь core и Base-report; Premium получает expanded + Voice только
  после сдачи; network unknown очищает stale expanded state; admin revoke немедленно возвращает Base
  и запрещает новый Voice. Отдельные launch-gate сценарии доказывают, что network-unknown и inactive
  не запускают новую cached training/full attempt.
- Catalog/offline: frozen 60-set invariants, exact 20/20/20 distribution, evidence/keys/content
  references, lazy chunks/runtime cache и технический fallback без записи Reading-прогресса.
- Accessibility: keyboard controls, visible focus, 44px report retry/actions, `aria-live` loading/error,
  non-colour table/progress/sample indicators, responsive desktop/mobile and reduced motion.
- Release commands and их итоговые количества фиксируются в `PROGRESS.md` после финального прогона.

## Релизная граница

Push, deploy, staging/production mutation, rollout flag, платёжный провайдер и VK ID в тикет не
входят. Уже принятые будущие направления VK ID и Robokassa-подобной оплаты сохранены в ADR; следующий
продуктовый этап после Reading 2.0 — цельный пробник всей письменной/устной частей ЕГЭ, а не расширение
Premium-ограничений на основной Reading.
