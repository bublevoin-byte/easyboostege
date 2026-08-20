# 07 — Контекстная Ася и честные voice states

Status: ready-for-agent
Blocked by: 01, 02, 03, 04, 05, 06
Spec: `.scratch/aisy-ux-redesign/spec.md#6-asya-interaction-contract`

## Что сделать

Добавить contextual Asya surface с абстрактной voice form, visible mic/session/transmission states,
bounded conversation lifecycle и существующим Voice Tutor bridge там, где он уже разрешён.

## Границы

- Имя пробуждения «Ася» действует только внутри deliberate open mic session.
- После пробуждения имя не нужно повторять до finish/leave/mic-off/timeout.
- Входит keyboard/button alternative и disclosure до передачи аудио.
- Не входит OS-wide/background wake word, новый provider, сохранение transcript/audio или paid test calls.
- В diagnostic/full EGE answer help запрещена.

## Файлы

- `public/asya-assistant.js`, `public/asya-assistant.css` — state machine и UI.
- `public/voice-tutor.js`, `public/realtime-transport.js` — bounded adapter без расширения authority.
- `public/index.html`, `public/main.js`, `public/service-worker.js`, `public/privacy.html`, `public/privacy.js` — integration/disclosure.
- `test/frontend-asya-assistant.test.js`, `e2e/asya-assistant.test.js` — privacy and interaction contract.

## Definition of Done

- [ ] UI не обещает глобальное или background wake-word поведение.
- [ ] Listening/transmitting/paused/off/error states видимы и screen-reader friendly.
- [ ] Другие имена не активируют conversation state в поддерживаемом wake seam.
- [ ] Follow-up phrase works without repeating «Ася» during active bounded session.
- [ ] Diagnostic/mock context cannot request answer help.
- [ ] Unit/E2E/privacy/security/lint/check/build pass with zero paid calls.
- [ ] Один коммит: `feat(aisy): add contextual asya assistant`.
