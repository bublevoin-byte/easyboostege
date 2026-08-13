# 05 — Устная часть 1–4

Status: ready-for-agent
Blocked by: 01, 02
Spec: .scratch/ege-full-mock-2026/spec.md#пользовательский-сценарий

## Что сделать

Интегрировать existing full Speaking flow как oral part одной попытки: mic/assets preflight до старта, отдельный строгий 17-минутный deadline, official preparation/recording stages, exact form binding, reload/recovery, replay-safe submit и предварительная evaluation. Пауза разрешена только между written submit и oral start.

## Границы

- Входит oral readiness, task 1–4 stage machine, owner-bound recordings/evaluation, technical failure states и part completion.
- Не входит генерация speaking prompts, изменение существующей pronunciation mastery и ручная экспертиза.
- Агент не запускает реальные provider/платные вызовы.

## Файлы

- `public/screens/speaking.js`, speaking modules — reusable deep seam/orchestration.
- `routes/`, `services/`, `validation/` — attempt/form/deadline binding.
- `test/`, `e2e/`, `docs/openapi.yaml` — timer/mic/replay/privacy parity.

## Definition of Done

- [ ] RED фиксирует отсутствие exact attempt/oral deadline binding.
- [ ] Timer запускается только после preflight и не ставится на паузу.
- [ ] Каждая запись принадлежит exact owner/attempt/form/task/stage.
- [ ] Reload/technical failure не создают вторую запись или evaluation.
- [ ] Preliminary labels и provider-failure pending state честны.
- [ ] Full gates, live PostgreSQL при server delta, fresh double ZERO и один commit.
