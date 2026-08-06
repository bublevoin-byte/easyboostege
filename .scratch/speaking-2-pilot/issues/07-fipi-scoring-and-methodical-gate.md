# 07 — Ввести детерминированную оценку ФИПИ и методический gate

Status: ready-for-agent
Blocked by: 06
Spec: `.scratch/speaking-2-pilot/spec.md#детерминированная-оценка`

## Что сделать

Ученик получает обоснованный примерный балл и разбор: Azure отвечает только за акустические факты, xAI — за ограниченную смысловую/языковую схему, а версионированный детерминированный комбинатор применяет критерии 1/4/5/10 и исключает двойные штрафы. Продукт не может назвать оценку методически валидированной до прохождения количественного gate.

## Границы

- Входит обновление xAI Speaking operation на server-owned assignment и строгую structured schema.
- Входит комбинатор критериев, confidence/needs-retry, ноль задания 4 при нуле за содержание и versioned review.
- Входит calibration dataset contract, offline metrics runner и release report со статусом pass/fail.
- Не входят платный quality run, фактические экспертные записи и включение validated badge.

## Файлы

- `ai/speaking.js`, `ai/operations.js` and assessment orchestration modules
- Speaking quality datasets/runner and documentation
- scoring, injection, quality and security tests

## Definition of Done

- [ ] Максимумы строго равны 1/4/5/10 и 20, а низкая уверенность даёт retry, не ложный ноль.
- [ ] xAI не может придумывать фонетические события или единолично менять балл.
- [ ] Одно событие не штрафуется по нескольким критериям без явного правила.
- [ ] Prompt injection в расшифровке остаётся недоверенными данными.
- [ ] Метка validated недоступна без versioned отчёта, двух оценок и всех порогов.
- [ ] Offline runner воспроизводимо считает MAE, within-one, critical recall/FPR, stability и subgroup metrics.
- [ ] Целевые тесты, `npm run lint`, `npm run check`, `npm test` проходят.
- [ ] Один коммит на тикет.
