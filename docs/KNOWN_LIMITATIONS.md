# Известные ограничения

## Azure pronunciation assessment

The production adapter is deliberately optional and remains unavailable until the official SDK, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, and the explicit enable switch are present. No fallback invents acoustic scores. Only `en-GB` and `en-US` are accepted. Azure exposes prosody, IPA phoneme names, syllables, and spoken-phoneme candidates only for `en-US`; `en-GB` still retains available acoustic scores but reports those fields as unavailable/absent. Provider acoustic scores are training signals, not validated FIPI/EGE points.

The verified Node SDK input accepts strict PCM16 mono 16 kHz WAV only. The official Speaking 1–4 browser flow now decodes `MediaRecorder` output locally and converts it to PCM16 mono 16 kHz WAV only after explicit learner action; the server still rejects WebM/MP4 and every other encoded container and has no transcoder.

- Полностью валидированный отдельный endpoint пока существует только для письменных заданий 37/38; генерация других модулей использует bounded legacy AI route.
- Оценка произношения по STT не заменяет фонетический анализ и не должна интерпретироваться как точная экспертная оценка.
- Offline mode сохраняет и синхронизирует прогресс по верхнеуровневым модулям; ИИ, Telegram, TTS/STT и подписка требуют сети.
- Browser matrix и полноценные E2E на реальных iPhone Safari/Android Chrome ещё не завершены.
- Ролевая модель преподавателя ещё не реализована; self-service экспорт и подтверждённое удаление данных доступны пользователю.
- До ротации production AI-ключей релиз считается ограниченным pre-release.
- Reading 2.0 закрывает отдельные тренировки и полный раздел чтения 10–18, но не является цельным пробником всей письменной и устной частей ЕГЭ; такой пробник остаётся следующим этапом.
- Расширенный Reading-отчёт показывает наблюдаемые связи только по завершённым каноническим попыткам (не более 120 последних строк). Малые выборки явно помечаются; темы, CEFR-метки и рекомендации не доказывают освоение или причинную связь.

## Ticket 07 controlled-update release dependency

Ticket 07 intentionally fails closed with `CLIENT_UPDATE_REQUIRED` when an ordinary Writing task request lacks the
new expected-owner/idempotency headers. The server performs no provider, quota, delivery or attempt mutation in
that case. A pre-Ticket07 page already running from an old service-worker cache can still catch HTTP 428 in its old
JavaScript and display the former fabricated local review; this server cannot repair text already embedded in that
legacy client without weakening owner intent or exactly-once safety.

Therefore Ticket 07 must not be deployed independently. Ticket 11 must first provide a controlled service-worker
version activation/cutover that prevents old active pages from submitting across the server change. This is a
release-order dependency only; Ticket 11 is not implemented here.
