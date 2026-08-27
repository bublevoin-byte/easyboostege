# 08 — Оформить говорение и контекстную Asya

**What to build:** Перенести speaking catalog, четыре типа заданий, полный раздел, pronunciation/accent состояния и
контекстную Asya в систему A, сохранив microphone/privacy, realtime recovery, quotas и учебный loop.

**Blocked by:** 03 — access check, Today и общая learner shell.

**Status:** done

**Spec anchor:** User Stories 16, 22–28, 31–36, 40, 48.

- [x] Speaking hub/task1–4/full-section states используют общие paper sheets, progress, status и deep dock.
- [x] Permission, recording, processing, playback, retry, pronunciation/accent feedback и quota видимо различаются.
- [x] Microphone controls имеют accessible names, pressed/state semantics и цели не меньше 44 px.
- [x] Asya остаётся contextual launcher/sheet, не шестой nav item, и использует ограниченный violet context accent.
- [x] Realtime connecting/recovery/text fallback/privacy/error states сообщают, что происходит и что можно сделать.
- [x] Existing speaking scoring, media, session storage, quotas и authority isolation не меняются.
- [x] Speaking/voice-tutor test suites и reduced-motion/responsive smoke проходят на production build.

## Verification

- Независимые Spec и Standards review: ZERO findings; дополнительный post-visual delta review: ZERO findings.
- Единый focused Speaking/Asya/Voice Tutor набор: 69/69; после финальных timer/disclaimer/phone-wrap правок affected tests: 14/14 и 8/8.
- `npm run lint`, `npm run check`, `npm run build:frontend`, `git diff --check`: green (только ожидаемые CRLF warnings).
- Chromium E2E: task 4 на 375/768/1024/1440 px; full Speaking на 375/1440 px; pronunciation status; Paper A Speaking; Asya; Paper A Voice Tutor — green. После визуальной правки Paper A Speaking повторно green.
- Ручной production-build QA на 390×844: portrait shell, hub, task 1, canonical coral CTA и contextual Asya проверены; перенос коротких setting controls исправлен и перепроверен скриншотом.
- Полный `npm test` запущен ровно один раз. Ticket-owned устаревшее ожидание дополнительного BEM-класса disclaimer исправлено и отдельно прошло 6/6. Два оставшихся класса отказа доказаны вне Ticket 08: `frontend-states` уже не удовлетворяется содержимым `HEAD`, а тайминговый `speaking-assessment-service` отдельно проходит 11/11; backend-файлы в diff отсутствуют.
