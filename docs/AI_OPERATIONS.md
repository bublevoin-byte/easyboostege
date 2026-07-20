# Реестр ИИ-операций

| Операция | Endpoint | Валидация | Fallback |
|---|---|---|---|
| Проверка задания 37 | `/api/v1/ai/evaluate-writing` | Zod request + server score validation | локальная проверка объёма |
| Проверка задания 38 | `/api/v1/ai/evaluate-writing` | Zod request + критерии/итоговый балл | локальная проверка объёма |
| Генерация учебного контента | `/api/ai` | ограниченные поля и длина промптов | встроенный банк заданий |
| TTS | `/api/tts` | auth, subscription, rate limit, voice allowlist | Web Speech API |
| STT | `/api/stt` | auth, subscription, rate limit, 20 MB body limit | повтор записи |

Версия prompt для письменной проверки задаётся `WRITING_PROMPT_VERSION` в `ai/writing.js` и записывается в `ai_requests`. Legacy-операции должны постепенно получить отдельные схемы и версии prompt до полного закрытия P0.
