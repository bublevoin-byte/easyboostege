# Реестр ИИ-операций

| Операция | Endpoint | Валидация | Fallback |
|---|---|---|---|
| Проверка задания 37 | `/api/v1/ai/evaluate-writing` | Zod request + server score validation | локальная проверка объёма |
| Проверка задания 38 | `/api/v1/ai/evaluate-writing` | Zod request + критерии/итоговый балл | локальная проверка объёма |
| Словарная справка | `/api/v1/ai/generate-content` (`dictionary_lookup`) | Zod request + строгий JSON output | мини-словарь |
| Тест по грамматике | `/api/v1/ai/generate-content` (`grammar_quiz`) | Zod request + ровно 5 валидированных заданий | встроенный банк заданий |
| Диалог для аудирования | `/api/v1/ai/generate-content` (`listening_dialog`) | Zod request + вопросы и допустимые индексы ответов | встроенное задание |
| Текст для чтения | `/api/v1/ai/generate-content` (`reading_text`) | Zod request + строгий JSON и 45–70 слов | встроенный текст |
| Словарные карточки | `/api/v1/ai/generate-content` (`vocabulary_cards`) | Zod request + строгая схема карточек и точное количество | встроенный словарь |
| Генерация задания 37 | `/api/v1/ai/generate-content` (`writing_task_37`) | 40–60 слов, минимум 3 вопроса, тема 2–4 слова | встроенный банк тем |
| Генерация задания 38 | `/api/v1/ai/generate-content` (`writing_task_38`) | 4–5 уникальных строк, целые проценты в сумме 100 | встроенный банк тем |
| Остальная legacy-генерация | `/api/ai` | ограниченные поля и длина промптов | встроенный банк заданий |
| TTS | `/api/tts` | auth, subscription, rate limit, voice allowlist | Web Speech API |
| STT | `/api/stt` | auth, subscription, rate limit, 20 MB body limit | повтор записи |

Версия prompt для письменной проверки задаётся `WRITING_PROMPT_VERSION` в `ai/writing.js`. Пять типизированных операций учебного контента используют `CONTENT_PROMPT_VERSION` из `ai/content.js`. Обе версии вместе с операцией, провайдером, моделью, длительностью и результатом записываются в `ai_requests`. Оставшиеся legacy-операции должны получить отдельные схемы до полного закрытия P0.
