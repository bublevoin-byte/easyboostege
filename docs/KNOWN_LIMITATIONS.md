# Известные ограничения

## Azure pronunciation assessment

The production adapter is deliberately optional and remains unavailable until the official SDK, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, and the explicit enable switch are present. No fallback invents acoustic scores. Only `en-GB` and `en-US` are accepted. Azure exposes prosody, IPA phoneme names, syllables, and spoken-phoneme candidates only for `en-US`; `en-GB` still retains available acoustic scores but reports those fields as unavailable/absent. Provider acoustic scores are training signals, not validated FIPI/EGE points.

The current verified Node SDK input accepts strict PCM16 mono 16 kHz WAV only. Browser MediaRecorder WebM/MP4 and other encoded containers are not advertised or silently treated as PCM; they remain local until a reviewed capture/transcoding seam is implemented.

- Полностью валидированный отдельный endpoint пока существует только для письменных заданий 37/38; генерация других модулей использует bounded legacy AI route.
- Оценка произношения по STT не заменяет фонетический анализ и не должна интерпретироваться как точная экспертная оценка.
- Offline mode сохраняет и синхронизирует прогресс по верхнеуровневым модулям; ИИ, Telegram, TTS/STT и подписка требуют сети.
- Browser matrix и полноценные E2E на реальных iPhone Safari/Android Chrome ещё не завершены.
- Ролевая модель преподавателя ещё не реализована; self-service экспорт и подтверждённое удаление данных доступны пользователю.
- До ротации production AI-ключей релиз считается ограниченным pre-release.
- Reading 2.0 закрывает отдельные тренировки и полный раздел чтения 10–18, но не является цельным пробником всей письменной и устной частей ЕГЭ; такой пробник остаётся следующим этапом.
- Расширенный Reading-отчёт показывает наблюдаемые связи только по завершённым каноническим попыткам (не более 120 последних строк). Малые выборки явно помечаются; темы, CEFR-метки и рекомендации не доказывают освоение или причинную связь.
